//! oc-tunnel: what `ssh -NT -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L a:b host`
//! does, for a small machine with no ssh client. One local port forwarded over SSH, with the server's key pinned and a
//! key of its own. The session comes up when a connection needs it and comes back after a drop.
//!
//!   oc-tunnel keygen <file>     makes an ed25519 key, mode 0600, never overwriting; prints only the public line
//!   oc-tunnel run --key <file> --known-host '<type> <base64>' --route user@host[:port] [--route ...]
//!                 [--listen 127.0.0.1:11436] [--target 127.0.0.1:11436] [--check]
//!
//! Routes are tried in order, each with a short TCP connect first: the LAN one, then any other. `--check` connects,
//! opens one channel to the target and ends: 0 if that worked. Nothing here prints key material.

use std::io::{self, Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::sync::Arc;
use std::time::Duration;

use russh::{client, Channel};
use russh::keys::ssh_key::private::Ed25519Keypair;
use russh::keys::ssh_key::LineEnding;
use russh::keys::{PrivateKey, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate};
use tokio::net::{TcpListener, TcpStream};

const DEFAULT_ADDR: &str = "127.0.0.1:11436";
/// `nc -z` against the LAN name, on the Mac.
const PROBE: Duration = Duration::from_secs(2);
const CONNECT: Duration = Duration::from_secs(10);
/// `ServerAliveInterval=30`, `ServerAliveCountMax=3`.
const ALIVE: Duration = Duration::from_secs(30);
const ALIVE_MAX: usize = 3;

#[derive(Clone, Debug, PartialEq)]
struct Route {
    user: String,
    host: String,
    port: u16,
}

impl Route {
    fn parse(s: &str) -> Option<Route> {
        let (user, rest) = s.split_once('@')?;
        let (host, port) = match rest.rsplit_once(':') {
            Some((h, p)) => (h, p.parse().ok()?),
            None => (rest, 22),
        };
        (!user.is_empty() && !host.is_empty()).then(|| Route { user: user.into(), host: host.into(), port })
    }
}

struct Options {
    key: String,
    known_host: PublicKey,
    routes: Vec<Route>,
    listen: String,
    target: (String, u32),
    check: bool,
}

struct Pinned(PublicKey);

impl client::Handler for Pinned {
    type Error = russh::Error;

    async fn check_server_key(&mut self, offered: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let same = matches!(offered, PublicKeyOrCertificate::PublicKey { key, .. } if key.key_data() == self.0.key_data());
        if !same {
            eprintln!("oc-tunnel: the server's key is not the pinned one");
        }
        Ok(same)
    }
}

type Session = client::Handle<Pinned>;

async fn connect(o: &Options, key: &Arc<PrivateKey>) -> Result<Session, String> {
    let mut last = String::from("no route");
    for r in &o.routes {
        let addr = format!("{}:{}", r.host, r.port);
        let tcp = match tokio::time::timeout(PROBE, TcpStream::connect(&addr)).await {
            Ok(Ok(t)) => t,
            Ok(Err(e)) => {
                last = format!("{addr}: {e}");
                continue;
            }
            Err(_) => {
                last = format!("{addr}: no answer");
                continue;
            }
        };
        let _ = tcp.set_nodelay(true);
        let config = Arc::new(client::Config {
            keepalive_interval: Some(ALIVE),
            keepalive_max: ALIVE_MAX,
            inactivity_timeout: None,
            ..Default::default()
        });
        let up = async {
            let mut h = client::connect_stream(config, tcp, Pinned(o.known_host.clone())).await.map_err(|e| e.to_string())?;
            let auth = h
                .authenticate_publickey(&r.user, PrivateKeyWithHashAlg::new(key.clone(), None))
                .await
                .map_err(|e| e.to_string())?;
            if !auth.success() {
                return Err("the server refused the key".to_string());
            }
            Ok(h)
        };
        match tokio::time::timeout(CONNECT, up).await {
            Ok(Ok(h)) => {
                eprintln!("oc-tunnel: up through {}@{addr}", r.user);
                return Ok(h);
            }
            Ok(Err(e)) => last = format!("{addr}: {e}"),
            Err(_) => last = format!("{addr}: timed out"),
        }
    }
    Err(last)
}

async fn open(session: &Session, o: &Options) -> Result<Channel<client::Msg>, String> {
    session
        .channel_open_direct_tcpip(o.target.0.clone(), o.target.1, "127.0.0.1", 0)
        .await
        .map_err(|e| format!("the server would not open {}:{}: {e}", o.target.0, o.target.1))
}

/// A channel on the session there is, or on a new one when that is gone: the server may have dropped it without our
/// noticing yet, and a request that has done nothing wrong should not pay for that.
async fn channel(session: &mut Option<Session>, o: &Options, key: &Arc<PrivateKey>) -> Result<Channel<client::Msg>, String> {
    if let Some(s) = session.as_ref().filter(|s| !s.is_closed()) {
        if let Ok(c) = open(s, o).await {
            return Ok(c);
        }
    }
    *session = None;
    let s = connect(o, key).await?;
    let c = open(&s, o).await;
    *session = Some(s);
    c
}

async fn run(o: Options) -> Result<(), String> {
    let key = Arc::new(russh::keys::load_secret_key(&o.key, None).map_err(|e| format!("key {}: {e}", o.key))?);
    if o.check {
        let session = connect(&o, &key).await?;
        open(&session, &o).await?;
        println!("ok");
        return Ok(());
    }
    // ExitOnForwardFailure: without the port there is nothing to do.
    let listener = TcpListener::bind(&o.listen).await.map_err(|e| format!("listen {}: {e}", o.listen))?;
    eprintln!("oc-tunnel: {} -> {}:{}", o.listen, o.target.0, o.target.1);
    let mut session: Option<Session> = None;
    loop {
        let (mut local, _) = listener.accept().await.map_err(|e| format!("accept: {e}"))?;
        let _ = local.set_nodelay(true);
        match channel(&mut session, &o, &key).await {
            Ok(c) => {
                let mut remote = c.into_stream();
                tokio::spawn(async move {
                    // A connection's end is its own affair: the session stays up for the next.
                    let _ = tokio::io::copy_bidirectional(&mut local, &mut remote).await;
                });
            }
            // The client sees its connection close, as with a dead ssh, and may try again.
            Err(e) => eprintln!("oc-tunnel: {e}"),
        }
    }
}

fn keygen(path: &str) -> Result<(), String> {
    let mut seed = [0u8; 32];
    std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut seed)).map_err(|e| format!("/dev/urandom: {e}"))?;
    let key = PrivateKey::from(Ed25519Keypair::from_seed(&seed));
    seed.fill(0);
    let text = key.to_openssh(LineEnding::LF).map_err(|e| e.to_string())?;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| if e.kind() == io::ErrorKind::AlreadyExists { format!("{path} already exists") } else { format!("{path}: {e}") })?;
    f.write_all(text.as_bytes()).and_then(|()| f.sync_all()).map_err(|e| format!("{path}: {e}"))?;
    println!("{}", key.public_key().to_openssh().map_err(|e| e.to_string())?);
    Ok(())
}

fn parse_target(s: &str) -> Option<(String, u32)> {
    let (h, p) = s.rsplit_once(':')?;
    Some((h.to_string(), p.parse().ok()?))
}

fn parse_run(args: &[String]) -> Result<Options, String> {
    let (mut key, mut known, mut routes, mut listen, mut target, mut check) =
        (None, None, Vec::new(), DEFAULT_ADDR.to_string(), DEFAULT_ADDR.to_string(), false);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let mut value = || it.next().cloned().ok_or(format!("{a} needs a value"));
        match a.as_str() {
            "--key" => key = Some(value()?),
            "--known-host" => {
                let v = value()?;
                known = Some(PublicKey::from_openssh(&v).map_err(|e| format!("--known-host: {e}"))?);
            }
            "--route" => {
                let v = value()?;
                routes.push(Route::parse(&v).ok_or(format!("--route {v}: not user@host[:port]"))?);
            }
            "--listen" => listen = value()?,
            "--target" => target = value()?,
            "--check" => check = true,
            other => return Err(format!("unknown argument {other}")),
        }
    }
    if routes.is_empty() {
        return Err("at least one --route".into());
    }
    Ok(Options {
        key: key.ok_or("--key is required")?,
        known_host: known.ok_or("--known-host is required: the server's key is always pinned")?,
        routes,
        listen,
        target: parse_target(&target).ok_or(format!("--target {target}: not host:port"))?,
        check,
    })
}

fn usage() -> i32 {
    eprintln!("usage: oc-tunnel keygen <file>\n       oc-tunnel run --key <file> --known-host '<type> <base64>' --route user@host[:port] [--route ...] [--listen addr] [--target addr] [--check]");
    64
}

/// The command line after the program name; returns the exit code. Makes its own runtime, so it is called outside one.
pub fn main_with(args: &[String]) -> i32 {
    match args.first().map(String::as_str) {
        Some("keygen") if args.len() == 2 => report(keygen(&args[1])),
        Some("run") => match parse_run(&args[1..]) {
            Ok(o) => {
                let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
                report(rt.block_on(run(o)))
            }
            Err(e) => {
                eprintln!("oc-tunnel: {e}");
                usage()
            }
        },
        _ => usage(),
    }
}

fn report(r: Result<(), String>) -> i32 {
    match r {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("oc-tunnel: {e}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes() {
        assert_eq!(
            Route::parse("nez@192.168.178.55"),
            Some(Route { user: "nez".into(), host: "192.168.178.55".into(), port: 22 })
        );
        assert_eq!(Route::parse("nez@127.0.0.1:2224").map(|r| r.port), Some(2224));
        assert_eq!(Route::parse("no-user-here"), None);
        assert_eq!(Route::parse("nez@host:notaport"), None);
    }
}
