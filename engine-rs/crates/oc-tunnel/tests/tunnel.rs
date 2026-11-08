//! The tunnel against an in-process SSH server: it forwards, it refuses a server whose key is not the pinned one, and it
//! comes back after the session drops.

use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use russh::keys::ssh_key::private::Ed25519Keypair;
use russh::keys::{PrivateKey, PublicKey};
use russh::server::{self, Auth, ChannelOpenHandle, Msg, Session};
use russh::Channel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const BIN: &str = env!("CARGO_BIN_EXE_oc-tunnel");

/// What `permitopen` and a key limit do: only this key, only this target.
#[derive(Clone)]
struct Server {
    allowed_key: PublicKey,
    target: String,
    channels: Arc<AtomicUsize>,
}

impl server::Handler for Server {
    type Error = russh::Error;

    async fn auth_publickey(&mut self, _user: &str, key: server::VerifiedPublicKey<'_>) -> Result<Auth, Self::Error> {
        if key.public_key.key_data() == self.allowed_key.key_data() {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::reject())
        }
    }

    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<Msg>,
        host: &str,
        port: u32,
        _originator: &str,
        _originator_port: u32,
        reply: ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        // Dropping the reply refuses the channel.
        if format!("{host}:{port}") != self.target {
            return Ok(());
        }
        self.channels.fetch_add(1, Ordering::SeqCst);
        reply.accept().await;
        let target = self.target.clone();
        tokio::spawn(async move {
            let mut stream = channel.into_stream();
            let mut remote = TcpStream::connect(target).await.unwrap();
            let _ = tokio::io::copy_bidirectional(&mut stream, &mut remote).await;
        });
        Ok(())
    }
}

fn key(seed: u8) -> PrivateKey {
    PrivateKey::from(Ed25519Keypair::from_seed(&[seed; 32]))
}

fn write_key(dir: &tempfile::TempDir, k: &PrivateKey) -> String {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.path().join("key");
    std::fs::write(&path, k.to_openssh(Default::default()).unwrap().as_bytes()).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    path.to_string_lossy().into_owned()
}

/// A TCP service that echoes.
async fn echo() -> String {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap().to_string();
    tokio::spawn(async move {
        loop {
            let (mut s, _) = l.accept().await.unwrap();
            tokio::spawn(async move {
                let (mut r, mut w) = s.split();
                let _ = tokio::io::copy(&mut r, &mut w).await;
            });
        }
    });
    addr
}

/// An SSH server on a port of its own.
async fn ssh_server(handler: Server, host_key: PrivateKey) -> (String, tokio::task::JoinHandle<()>) {
    let config = Arc::new(server::Config {
        keys: vec![host_key],
        auth_rejection_time: Duration::from_millis(1),
        auth_rejection_time_initial: Some(Duration::ZERO),
        ..Default::default()
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    let task = tokio::spawn(async move {
        let mut sessions = tokio::task::JoinSet::new();
        loop {
            let (s, _) = listener.accept().await.unwrap();
            let config = config.clone();
            let handler = handler.clone();
            sessions.spawn(async move {
                if let Ok(session) = server::run_stream(config, s, handler).await {
                    let _ = session.await;
                }
            });
        }
    });
    (addr, task)
}

fn free_port() -> String {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    l.local_addr().unwrap().to_string()
}

fn known(k: &PrivateKey) -> String {
    k.public_key().to_openssh().unwrap()
}

fn start(key: &str, known_host: &str, route: &str, listen: &str, target: &str) -> tokio::process::Child {
    tokio::process::Command::new(BIN)
        .args(["run", "--key", key, "--known-host", known_host, "--route", route, "--listen", listen, "--target", target])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap()
}

async fn round_trip(listen: &str) -> Result<Vec<u8>, String> {
    let mut c = None;
    for _ in 0..100 {
        match TcpStream::connect(listen).await {
            Ok(s) => {
                c = Some(s);
                break;
            }
            Err(_) => tokio::time::sleep(Duration::from_millis(20)).await,
        }
    }
    let mut c = c.ok_or("the tunnel never listened")?;
    c.write_all(b"ping").await.map_err(|e| e.to_string())?;
    let mut buf = [0u8; 4];
    tokio::time::timeout(Duration::from_secs(5), c.read_exact(&mut buf))
        .await
        .map_err(|_| "no answer".to_string())?
        .map_err(|e| e.to_string())?;
    Ok(buf.to_vec())
}

#[tokio::test]
async fn forwards_through_the_session_and_reuses_it() {
    let dir = tempfile::tempdir().unwrap();
    let (client, host) = (key(1), key(2));
    let target = echo().await;
    let channels = Arc::new(AtomicUsize::new(0));
    let handler = Server { allowed_key: client.public_key().clone(), target: target.clone(), channels: channels.clone() };
    let (addr, _srv) = ssh_server(handler, host.clone()).await;
    let listen = free_port();
    let key_file = write_key(&dir, &client);
    let _t = start(&key_file, &known(&host), &format!("nez@{addr}"), &listen, &target);
    assert_eq!(round_trip(&listen).await.unwrap(), b"ping");
    assert_eq!(round_trip(&listen).await.unwrap(), b"ping");
    assert_eq!(channels.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn refuses_a_server_with_another_key() {
    let dir = tempfile::tempdir().unwrap();
    let (client, host) = (key(3), key(4));
    let target = echo().await;
    let channels = Arc::new(AtomicUsize::new(0));
    let handler = Server { allowed_key: client.public_key().clone(), target: target.clone(), channels: channels.clone() };
    let (addr, _srv) = ssh_server(handler, host).await;
    let key_file = write_key(&dir, &client);
    let out = tokio::process::Command::new(BIN)
        .args(["run", "--key", &key_file, "--known-host", &known(&key(5)), "--route", &format!("nez@{addr}"), "--target", &target, "--check"])
        .output()
        .await
        .unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("not the pinned one"));
    assert_eq!(channels.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_key_the_server_does_not_know_and_a_target_it_forbids_fail() {
    let dir = tempfile::tempdir().unwrap();
    let (client, host) = (key(6), key(7));
    let target = echo().await;
    let handler = Server { allowed_key: key(8).public_key().clone(), target: target.clone(), channels: Arc::default() };
    let (addr, _srv) = ssh_server(handler, host.clone()).await;
    let key_file = write_key(&dir, &client);
    let args = |t: &str| {
        vec!["run".to_string(), "--key".into(), key_file.clone(), "--known-host".into(), known(&host), "--route".into(), format!("nez@{addr}"), "--target".into(), t.to_string(), "--check".into()]
    };
    let out = tokio::process::Command::new(BIN).args(args(&target)).output().await.unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("refused the key"), "{}", String::from_utf8_lossy(&out.stderr));

    let handler = Server { allowed_key: client.public_key().clone(), target: target.clone(), channels: Arc::default() };
    let (addr2, _srv2) = ssh_server(handler, host.clone()).await;
    let out = tokio::process::Command::new(BIN)
        .args(["run", "--key", &key_file, "--known-host", &known(&host), "--route", &format!("nez@{addr2}"), "--target", "127.0.0.1:1", "--check"])
        .output()
        .await
        .unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("would not open"), "{}", String::from_utf8_lossy(&out.stderr));
}

#[tokio::test]
async fn takes_the_next_route_when_the_first_is_down() {
    let dir = tempfile::tempdir().unwrap();
    let (client, host) = (key(9), key(10));
    let target = echo().await;
    let handler = Server { allowed_key: client.public_key().clone(), target: target.clone(), channels: Arc::default() };
    let (addr, _srv) = ssh_server(handler, host.clone()).await;
    let listen = free_port();
    let key_file = write_key(&dir, &client);
    let down = free_port();
    let _t = tokio::process::Command::new(BIN)
        .args(["run", "--key", &key_file, "--known-host", &known(&host), "--route", &format!("nez@{down}"), "--route", &format!("nez@{addr}"), "--listen", &listen, "--target", &target])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    assert_eq!(round_trip(&listen).await.unwrap(), b"ping");
}

#[tokio::test]
async fn comes_back_after_the_server_is_gone() {
    let dir = tempfile::tempdir().unwrap();
    let (client, host) = (key(11), key(12));
    let target = echo().await;
    let handler = Server { allowed_key: client.public_key().clone(), target: target.clone(), channels: Arc::default() };
    // The same port twice: the first server dies with its sessions, the second takes over.
    let port = free_port();
    let config = Arc::new(server::Config { keys: vec![host.clone()], ..Default::default() });
    let serve = |config: Arc<server::Config>, handler: Server, port: String| async move {
        let listener = TcpListener::bind(&port).await.unwrap();
        let mut sessions = tokio::task::JoinSet::new();
        loop {
            let (s, _) = listener.accept().await.unwrap();
            let (config, handler) = (config.clone(), handler.clone());
            sessions.spawn(async move {
                if let Ok(session) = server::run_stream(config, s, handler).await {
                    let _ = session.await;
                }
            });
        }
    };
    let first = tokio::spawn(serve(config.clone(), handler.clone(), port.clone()));
    tokio::time::sleep(Duration::from_millis(50)).await;
    let listen = free_port();
    let key_file = write_key(&dir, &client);
    let _t = start(&key_file, &known(&host), &format!("nez@{port}"), &listen, &target);
    assert_eq!(round_trip(&listen).await.unwrap(), b"ping");

    first.abort();
    let _ = first.await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let _second = tokio::spawn(serve(config, handler, port));
    tokio::time::sleep(Duration::from_millis(50)).await;
    // The first attempt after the drop already gets through: the tunnel opens a new session for it.
    assert_eq!(round_trip(&listen).await.unwrap(), b"ping");
}

#[test]
fn keygen_writes_a_private_file_and_prints_only_the_public_line() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("k");
    let out = std::process::Command::new(BIN).arg("keygen").arg(&path).output().unwrap();
    assert!(out.status.success());
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert!(stdout.starts_with("ssh-ed25519 "));
    assert!(!stdout.contains("PRIVATE"));
    assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    let again = std::process::Command::new(BIN).arg("keygen").arg(&path).output().unwrap();
    assert!(!again.status.success(), "it must not overwrite a key");
}
