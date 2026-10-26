import { app } from "electron"

type Channel = "local" | "dev" | "beta" | "prod"

const raw = import.meta.env.OPENCODE_CHANNEL

export const CHANNEL: Channel = raw === "local" || raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

export const VERSION = app.isPackaged ? app.getVersion() : (process.env.OPENCODE_VERSION ?? app.getVersion())

const appNames: Record<Channel, string> = {
  local: "Secretary Code Dev",
  dev: "Secretary Code Dev",
  beta: "Secretary Code Beta",
  prod: "Secretary Code",
}

const appIDs: Record<Channel, string> = {
  local: "app.secretary.code.dev",
  dev: "app.secretary.code.dev",
  beta: "app.secretary.code.beta",
  prod: "app.secretary.code",
}

// Local renderer/server mode keeps the dev application identity.
export const APP_NAME = app.isPackaged ? appNames[CHANNEL] : "Secretary Code Dev"

export const APP_ID = app.isPackaged ? appIDs[CHANNEL] : "app.secretary.code.dev"
