// The sidecar password never crosses into the renderer; the main process adds it to sidecar requests.
export type ServerReadyData = {
  url: string
}

export type TitlebarTheme = {
  mode: "light" | "dark"
  scheme?: "system" | "light" | "dark"
}

export type FatalRendererError = {
  error: string
  url: string
  version?: string
  platform: string
  os?: string
  /** The owner's note from the fatal screen, sent with an explicit "Send to Lucina". */
  note?: string
  /** True when the owner pressed "Send to Lucina" rather than automatic reporting. */
  userInitiated?: boolean
}

/** What the fatal screen shows after a report was recorded: its id and whether Lucina has it. */
export type DiagnosticReportReceipt = {
  id: string
  sent: boolean
}

export type DiagnosticsSettings = { automatic: boolean }

export type AgentsMirrorSettings = { enabled: boolean }

export type DirectoryPickerOptions = {
  multiple?: boolean
  title?: string
  defaultPath?: string
}

export type FilePickerOptions = DirectoryPickerOptions & {
  extensions?: string[]
}

export type PickedFiles = {
  token: string
  files: { path: string; name: string; size: number }[]
}

export type SaveFilePickerOptions = {
  title?: string
  defaultPath?: string
}

export type ClipboardImage = {
  buffer: ArrayBuffer
  width: number
  height: number
}
