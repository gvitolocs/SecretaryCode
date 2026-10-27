import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { SafeStorage } from "electron"

/** A single encrypted identity file is shared by all viewer windows and survives app restarts. */
export async function deviceID(
  directory: string,
  storage: Pick<SafeStorage, "isEncryptionAvailable" | "encryptString" | "decryptString">,
) {
  if (!storage.isEncryptionAvailable()) throw new Error("Device identity encryption is unavailable")
  const file = path.join(directory, "lucina-device")
  const saved = await readFile(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
  })
  if (saved) {
    const id = storage.decryptString(saved)
    if (!/^mac-[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/.test(id)) throw new Error("Invalid saved device identity")
    return id
  }
  const id = `mac-${randomUUID()}`
  await mkdir(directory, { recursive: true })
  await writeFile(file, storage.encryptString(id), { mode: 0o600 })
  return id
}
