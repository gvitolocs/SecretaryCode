import { afterEach, describe, expect, test } from "bun:test"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { gunzipSync } from "node:zlib"
import { DIAGNOSTICS_PATH, MAX_UPLOAD_BYTES, UploadError, sendReport } from "./client"
import { createReport } from "./report"

const servers: (() => Promise<unknown>)[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((close) => close()))
})

type Received = { method?: string; url?: string; authorization?: string; client?: string; form?: FormData }

/** A stand-in for Lucina's intake: records one request, then answers with `status` and `body`. */
async function intake(status = 201, body: unknown = { id: "rep_01J8Z" }) {
  const received: Received = {}
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []

    for await (const chunk of request) chunks.push(chunk)
    received.method = request.method
    received.url = request.url
    received.authorization = request.headers.authorization
    received.client = request.headers["x-secretary-client"] as string | undefined
    received.form = await new Request("http://intake.local", {
      method: "POST",
      headers: { "Content-Type": String(request.headers["content-type"]) },
      body: Buffer.concat(chunks),
    }).formData()

    response.writeHead(status, { "Content-Type": "application/json" })
    response.end(JSON.stringify(body))
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  servers.push(() => new Promise((resolve) => server.close(resolve)))

  return { received, baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: "sec_device_token" }
}

const report = createReport({
  kind: "fatal_error",
  message: "The application could not start",
  stack: "at hydrate (app.tsx:1:1)",
  context: { url: "app://index.html", note: "it hung on launch" },
  appVersion: "2.1.4",
  os: "darwin 15.1 arm64",
  device: "MacBook 1a2b3c4d",
  occurredAt: new Date("2026-10-27T08:00:00.000Z"),
})

const logs = { name: "main.log", data: new TextEncoder().encode("[error] boom\n") }

describe("sending a report to Lucina", () => {
  test("posts the report as one JSON part with the device token and gzipped logs", async () => {
    const lucina = await intake()

    const result = await sendReport(report, [logs], { baseURL: lucina.baseURL, token: lucina.token })

    expect(result).toEqual({ id: "rep_01J8Z" })
    expect(lucina.received.method).toBe("POST")
    expect(lucina.received.url).toBe(DIAGNOSTICS_PATH)
    expect(lucina.received.authorization).toBe(`Bearer ${lucina.token}`)
    expect(lucina.received.client).toBe("web")

    const form = lucina.received.form!
    // The server reads the report from one JSON part and rejects any other plain field.
    expect([...form.keys()].toSorted()).toEqual(["attachments", "report"])
    expect(JSON.parse(String(form.get("report")))).toEqual({
      app: "secretary-code",
      app_version: "2.1.4",
      os: "darwin 15.1 arm64",
      device: "MacBook 1a2b3c4d",
      kind: "fatal_error",
      message: "The application could not start",
      stack: "at hydrate (app.tsx:1:1)",
      context: { url: "app://index.html", note: "it hung on launch" },
      occurred_at: "2026-10-27T08:00:00.000Z",
    })

    const attachment = form.get("attachments") as File
    expect(attachment.name).toBe("0-main.log.gz")
    expect(attachment.type).toBe("application/gzip")
    expect(gunzipSync(await attachment.arrayBuffer()).toString()).toBe("[error] boom\n")
  })

  test("leaves out attachments past the server's size cap", async () => {
    const lucina = await intake()
    const dump = { name: "crashpad/big.dmp", data: new Uint8Array(MAX_UPLOAD_BYTES) }

    await sendReport(report, [logs, dump], { baseURL: lucina.baseURL, token: lucina.token })

    expect(lucina.received.form!.getAll("attachments").map((file) => (file as File).name)).toEqual(["0-main.log.gz"])
  })

  test.each([
    [401, "signInRequired", false],
    [403, "signInRequired", false],
    [400, "rejected", false],
    [429, "offline", true],
    [503, "offline", true],
  ])("classifies an HTTP %i answer as %s", async (status, code, retryable) => {
    const lucina = await intake(status, { error: "nope" })

    const error = await sendReport(report, [logs], { baseURL: lucina.baseURL, token: lucina.token }).catch(
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(UploadError)
    expect((error as UploadError).code).toBe(code)
    expect((error as UploadError).retryable).toBe(retryable)
  })

  test("an unreachable Lucina is retried later, not dropped", async () => {
    const error = await sendReport(report, [logs], { baseURL: "http://127.0.0.1:1", token: "sec_token" }).catch(
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(UploadError)
    expect((error as UploadError).code).toBe("offline")
    expect((error as UploadError).retryable).toBe(true)
  })
})
