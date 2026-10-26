import { describe, expect, test } from "bun:test"
import { parseHelperLine, type HelperEvent } from "./protocol"
import { DEFAULT_SETTINGS, parseSettings } from "./settings"
import { IDLE, parseRequest, reduce, rejection, type ActiveRecording, type Phase, type RecorderEvent } from "./state"

const ID = "8d0b8f5e-7c55-4f0e-9d7b-2a8d8d2f5d11"

describe("IPC requests from the Record sheet", () => {
  // Raw (action, input) pairs exactly as window.electron.recorder.request sends them.
  test.each([
    ["snapshot", undefined, { action: "snapshot" }],
    [
      "start",
      {
        source: { kind: "app", bundleId: "us.zoom.xos", name: "zoom.us" },
        title: " Lecture 4 ",
        calendarEventId: "evt_1",
      },
      {
        action: "start",
        source: { kind: "app", bundleId: "us.zoom.xos", name: "zoom.us" },
        title: "Lecture 4",
        calendarEventId: "evt_1",
      },
    ],
    [
      "start",
      { source: { kind: "window", windowId: 4242, title: "Meet - Standup", bundleId: "com.google.Chrome" }, title: "" },
      {
        action: "start",
        source: { kind: "window", windowId: 4242, title: "Meet - Standup", bundleId: "com.google.Chrome", name: null },
        title: "",
        calendarEventId: null,
      },
    ],
    [
      "start",
      { source: { kind: "display", displayId: 1 }, title: "Whiteboard" },
      {
        action: "start",
        source: { kind: "display", displayId: 1, name: null },
        title: "Whiteboard",
        calendarEventId: null,
      },
    ],
    ["requestPermission", "microphone", { action: "requestPermission", permission: "microphone" }],
    ["retryUpload", ID, { action: "retryUpload", id: ID }],
  ] as const)("%s accepts %j", (action, input, expected) => {
    expect(parseRequest(action, input)).toEqual(expected)
  })

  test.each([
    ["delete", undefined],
    [undefined, undefined],
    ["start", undefined],
    ["start", { source: { kind: "tab", id: 1 }, title: "x" }],
    ["start", { source: { kind: "app", bundleId: "us.zoom.xos; rm -rf /" }, title: "x" }],
    ["start", { source: { kind: "window", windowId: -1 }, title: "x" }],
    ["start", { source: { kind: "display", displayId: 1.5 }, title: "x" }],
    ["start", { source: { kind: "display", displayId: 1 }, title: "x".repeat(201) }],
    ["start", { source: { kind: "display", displayId: 1 }, title: "bell\u0007" }],
    ["requestPermission", "camera"],
    ["openFolder", "../../etc"],
    ["openTranscript", 42],
  ] as const)("%s rejects %j", (action, input) => {
    expect(() => parseRequest(action, input)).toThrow()
  })

  const start = parseRequest("start", { source: { kind: "display", displayId: 1 }, title: "x" })
  test.each([
    ["idle", start, null],
    ["recording", start, "alreadyRecording"],
    ["stopping", start, "alreadyRecording"],
    ["recording", { action: "pause" }, null],
    ["paused", { action: "pause" }, "notRecording"],
    ["paused", { action: "resume" }, null],
    ["recording", { action: "resume" }, "notPaused"],
    ["recording", { action: "stop" }, null],
    ["paused", { action: "stop" }, null],
    ["idle", { action: "stop" }, "notRecording"],
    ["starting", { action: "stop" }, "notRecording"],
    ["idle", { action: "saveSettings", settings: {} }, null],
    ["recording", { action: "saveSettings", settings: {} }, "settingsLocked"],
    ["recording", { action: "snapshot" }, null],
  ] as const)("in %s, %j is refused with %p", (phase, request, expected) => {
    expect(rejection(phase as Phase, request)).toBe(expected)
  })
})

describe("recording state machine", () => {
  const source = { kind: "app", bundleId: "com.microsoft.teams2", name: "Microsoft Teams" } as const

  const helper = (line: string): RecorderEvent => {
    const message = parseHelperLine(line)

    if (message?.type !== "event") throw new Error(`not an event: ${line}`)

    return { type: "helper", event: message.value }
  }

  const run = (events: RecorderEvent[]) => events.reduce<ActiveRecording>(reduce, IDLE)
  const begin: RecorderEvent = {
    type: "start",
    id: ID,
    directory: "/Users/me/Movies/Secretary Recordings/2026-10-26 1430 Sync",
    title: "Sync",
    source,
  }

  test("a recording runs from start to stop with the helper's own lines", () => {
    const states = [
      begin,
      helper('{"event":"started","startedAt":"2026-10-26T13:30:00.000Z","tracks":["system.m4a","mic.m4a"]}'),
      helper(
        '{"event":"status","state":"recording","elapsed":61.5,"levels":{"system":-18,"mic":-31},"files":{"system.m4a":1048576,"mic.m4a":524288}}',
      ),
      helper(
        '{"event":"status","state":"paused","elapsed":62,"levels":{},"files":{"system.m4a":1050000,"mic.m4a":530000}}',
      ),
      { type: "stop" } as const,
      helper(
        '{"event":"stopped","startedAt":"2026-10-26T13:30:00.000Z","endedAt":"2026-10-26T13:31:02.000Z","duration":62,"tracks":[]}',
      ),
    ].reduce<ActiveRecording[]>((all, event) => [...all, reduce(all.at(-1) ?? IDLE, event)], [])

    expect(states.map((state) => state.phase)).toEqual([
      "starting",
      "recording",
      "recording",
      "paused",
      "stopping",
      "idle",
    ])
    expect(states[2]).toMatchObject({
      elapsed: 61.5,
      levels: { system: -18, mic: -31 },
      files: { "system.m4a": 1048576, "mic.m4a": 524288 },
    })
    expect(states.at(-1)).toEqual(IDLE)
  })

  test.each([
    [
      "a refused start returns to idle with the reason",
      [begin, { type: "start-failed", code: "permission-screen", message: "Screen Recording is not allowed" }],
      { ...IDLE, error: { code: "permission-screen", message: "Screen Recording is not allowed" } },
    ],
    [
      "a fatal capture error ends in idle and keeps the reason",
      [
        begin,
        helper('{"event":"started","startedAt":"t"}'),
        helper('{"event":"error","code":"capture-failed","message":"Window closed","fatal":true}'),
        helper('{"event":"stopped","tracks":[]}'),
      ],
      { ...IDLE, error: { code: "capture-failed", message: "Window closed" } },
    ],
    [
      "a helper crash while recording ends the recording",
      [begin, helper('{"event":"started","startedAt":"t"}'), { type: "helper-exited" }],
      { ...IDLE, error: { code: "helper-exited", message: "The recorder stopped unexpectedly" } },
    ],
    [
      "a second start while recording is ignored",
      [begin, helper('{"event":"started","startedAt":"t"}'), { ...begin, id: "other" }],
      { phase: "recording", id: ID },
    ],
    [
      "status lines before the helper confirms the start are ignored",
      [begin, helper('{"event":"status","state":"recording","elapsed":3}')],
      { phase: "starting", elapsed: 0 },
    ],
    [
      "a non-fatal error keeps recording",
      [
        begin,
        helper('{"event":"started","startedAt":"t"}'),
        helper('{"event":"error","code":"x","message":"y","fatal":false}'),
      ],
      { phase: "recording", error: null },
    ],
    [
      "late status after stop does not resurrect the recording",
      [
        begin,
        helper('{"event":"started","startedAt":"t"}'),
        helper('{"event":"stopped","tracks":[]}'),
        helper('{"event":"status","state":"recording","elapsed":9}'),
      ],
      IDLE,
    ],
  ] as [string, RecorderEvent[], Partial<ActiveRecording>][])("%s", (_name, events, expected) => {
    expect(run(events)).toMatchObject(expected)
  })

  test("helper lines outside the protocol are ignored", () => {
    for (const line of ["", "not json", "[1,2]", '{"event":"unknown"}', '{"event":"app-launched"}'])
      expect(parseHelperLine(line)).toBeUndefined()
    const launched = parseHelperLine('{"event":"app-launched","bundleId":"us.zoom.xos","name":"zoom.us"}')
    expect(launched).toEqual({
      type: "event",
      value: { event: "app-launched", bundleId: "us.zoom.xos", name: "zoom.us" } satisfies HelperEvent,
    })
    expect(parseHelperLine('{"id":"4","ok":false,"error":{"code":"permission-screen","message":"off"}}')).toEqual({
      type: "reply",
      id: "4",
      ok: false,
      code: "permission-screen",
      message: "off",
    })
  })
})

describe("settings page input", () => {
  // The settings page sends one changed field per `saveSettings` request.
  test.each([
    [{ video: false }, { ...DEFAULT_SETTINGS, video: false }],
    [{ resolution: "720p", fps: 60, codec: "h264", bitrateKbps: 4000 }, { ...DEFAULT_SETTINGS, resolution: "720p", fps: 60, codec: "h264", bitrateKbps: 4000 }],
    [{ microphone: "BuiltInMicrophoneDevice" }, { ...DEFAULT_SETTINGS, microphone: "BuiltInMicrophoneDevice" }],
    [{ microphone: null, microphoneEnabled: false }, { ...DEFAULT_SETTINGS, microphone: null, microphoneEnabled: false }],
    [{ systemAudio: "system", keepDays: 0, suggest: false }, { ...DEFAULT_SETTINGS, systemAudio: "system", keepDays: 0, suggest: false }],
  ] as const)("applies %j", (input, expected) => {
    expect(parseSettings(parseRequest("saveSettings", input).settings, DEFAULT_SETTINGS)).toEqual(expected)
  })

  test.each([
    [null],
    [{ fps: 24 }],
    [{ fps: "30" }],
    [{ resolution: "4k" }],
    [{ codec: "av1" }],
    [{ bitrateKbps: 100 }],
    [{ bitrateKbps: 6000.5 }],
    [{ keepDays: -1 }],
    [{ microphone: "" }],
    [{ systemAudio: "off" }],
    [{ video: "yes" }],
  ])("rejects %j", (input) => {
    expect(() => parseSettings(input, DEFAULT_SETTINGS)).toThrow()
  })
})
