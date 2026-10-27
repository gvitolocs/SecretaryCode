import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

export const RustEngineRoutes = Schema.Struct({
  portedTotal: Schema.Number,
  portedMatched: Schema.Number,
  v2Total: Schema.Number,
  beyondV2: Schema.Array(Schema.String),
})

/** What the settings panel shows; `error` is already safe to display and never contains a credential. */
export const RustEngineStatus = Schema.Struct({
  enabled: Schema.Boolean,
  running: Schema.Boolean,
  port: Schema.optional(Schema.Number),
  version: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  routes: RustEngineRoutes,
})
export type RustEngineStatus = typeof RustEngineStatus.Type

const Latency = Schema.Struct({ ms: Schema.Number, ok: Schema.Boolean })

/** A health ping for each engine: the Rust preview server and, when the renderer names it, the TypeScript one. */
export const RustEngineLatency = Schema.Struct({
  rust: Schema.optional(Latency),
  ts: Schema.optional(Latency),
})
export type RustEngineLatency = typeof RustEngineLatency.Type

export const RustEngineStatusRpc = Rpc.make("RustEngineStatus", { success: RustEngineStatus })

export const RustEngineSetEnabled = Rpc.make("RustEngineSetEnabled", {
  payload: { enabled: Schema.Boolean },
  success: RustEngineStatus,
})

export const RustEnginePing = Rpc.make("RustEnginePing", {
  payload: { tsUrl: Schema.optional(Schema.String) },
  success: RustEngineLatency,
})

export const RustEngineRpcs = RpcGroup.make(RustEngineStatusRpc, RustEngineSetEnabled, RustEnginePing)
