import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import path from "node:path"
import { dict as da } from "@/runtime/i18n/da"
import { dict as en } from "@/runtime/i18n/en"
import { dict as it } from "@/runtime/i18n/it"

const LUCINA_KEYS = [
  "error.page.report.lucina",
  "error.page.report.queued",
  "error.page.report.id",
  "error.page.report.failed",
  "error.page.action.sendToLucina",
  "error.page.action.sending",
  "error.page.note.label",
  "error.page.note.placeholder",
  "settings.general.row.crashReports.title",
  "settings.general.row.crashReports.description",
] as const

const directory = path.join(import.meta.dir, "../../runtime/i18n")

/** Every locale dictionary, keyed by its file name. */
async function locales() {
  const files = (await readdir(directory)).filter((name) => /^[a-z]{2,3}\.ts$/.test(name))

  return Promise.all(
    files.map(async (file) => ({
      locale: file.replace(/\.ts$/, ""),
      dict: ((await import(path.join(directory, file))) as { dict: Record<string, string> }).dict,
    })),
  )
}

describe("fatal screen strings", () => {
  test.each([
    ["en", en],
    ["da", da],
    ["it", it],
  ] as const)("%s has every Lucina string, with the report id placeholder", (_, dict) => {
    const strings = dict as Record<string, string>

    for (const key of LUCINA_KEYS) expect(strings[key]?.trim()).toBeTruthy()
    expect(strings["error.page.report.id"]).toContain("{{id}}")
    expect(strings["error.page.action.sendToLucina"]).toContain("Lucina")
  })

  test("Danish and Italian are translated, not copies of English", () => {
    for (const key of LUCINA_KEYS) {
      expect(da[key]).not.toBe(en[key])
      expect(it[key]).not.toBe(en[key])
    }
  })

  test("no locale still asks to report errors to the OpenCode team or on Discord", async () => {
    for (const { locale, dict } of await locales()) {
      const removed = ["error.page.report.prefix", "error.page.report.discord"].filter((key) => key in dict)
      expect({ locale, removed }).toEqual({ locale, removed: [] })

      const fatal = Object.entries(dict).filter(([key]) => key.startsWith("error.page."))
      expect({ locale, links: fatal.filter(([, value]) => /discord|opencode/i.test(value)) }).toEqual({ locale, links: [] })
    }
  })
})
