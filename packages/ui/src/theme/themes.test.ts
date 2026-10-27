import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { contrastRatio } from "./color"
import { DEFAULT_THEMES } from "./default-themes"
import { resolveThemeVariant } from "./resolve"
import type { HexColor } from "./types"
import { resolveThemeVariantV2 } from "./v2/resolve"

const COLOR = /^(#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|var\(--[a-z0-9-]+\))$/
const ids = readdirSync(new URL("./themes", import.meta.url))
  .filter((file) => file.endsWith(".json"))
  .map((file) => file.slice(0, -".json".length))

describe("bundled themes", () => {
  test("every theme file is registered under its own id", () => {
    for (const id of ids) expect(DEFAULT_THEMES[id]?.id).toBe(id)
    expect(Object.keys(DEFAULT_THEMES).sort()).toEqual([...ids].sort())
  })

  test.each(ids)("%s resolves in light and dark with a valid color in every v1 override", (id) => {
    const theme = DEFAULT_THEMES[id]!

    for (const [variant, dark] of [
      [theme.light, false],
      [theme.dark, true],
    ] as const) {
      expect(Object.keys(resolveThemeVariant(variant, dark)).length).toBeGreaterThan(100)
      expect(Object.keys(resolveThemeVariantV2(variant, dark)).length).toBeGreaterThan(100)

      for (const [token, value] of Object.entries(variant.overrides ?? {})) {
        expect(COLOR.test(value), `${id} ${dark ? "dark" : "light"} override ${token}: ${value}`).toBe(true)
      }
    }
  })
})

describe("Lucina theme", () => {
  const theme = DEFAULT_THEMES.lucina!

  test("defines every token the default theme does, in both modes", () => {
    const base = DEFAULT_THEMES["oc-2"]!

    for (const mode of ["light", "dark"] as const) {
      const dark = mode === "dark"
      const want = Object.keys(resolveThemeVariant(base[mode], dark))
      const have = resolveThemeVariant(theme[mode], dark)
      for (const token of want) expect(have[token], `${mode} ${token}`).toBeDefined()

      const wantV2 = Object.keys(resolveThemeVariantV2(base[mode], dark)).filter((token) => !token.startsWith("v2-font-"))
      const haveV2 = resolveThemeVariantV2(theme[mode], dark)
      for (const token of wantV2) expect(haveV2[token], `${mode} ${token}`).toBeDefined()
    }
  })

  test.each([
    ["dark", "#090c1e", "#11172a", "#f0f0f2", "#5ee3e7", "#12242a"],
    ["light", "#f2f2f7", "#ffffff", "#000000", "#4a5bb5", "#ffffff"],
  ] as const)("%s paints the approved palette", (mode, background, card, text, accent, ink) => {
    const dark = mode === "dark"
    const v1 = resolveThemeVariant(theme[mode], dark)
    const v2 = resolveThemeVariantV2(theme[mode], dark)

    expect(v1["background-base"]).toBe(background)
    expect(v1["surface-base"]).toBe(card)
    expect(v1["text-strong"]).toBe(text)
    expect(v2["v2-grey-100"] === `${text}ff` || mode === "light").toBe(true)
    expect(v2["v2-background-bg-contrast"]).toBe(accent)
    expect(v2["v2-text-text-contrast"]).toBe(ink)
    expect(v2["v2-lucina-user-bubble"]).toStartWith("linear-gradient(")
  })

  test.each(["light", "dark"] as const)("%s keeps text readable on the background and cards", (mode) => {
    const v1 = resolveThemeVariant(theme[mode], mode === "dark")
    const bg = v1["background-base"] as HexColor
    const card = v1["surface-base"] as HexColor

    expect(contrastRatio(v1["text-strong"] as HexColor, bg)).toBeGreaterThanOrEqual(7)
    expect(contrastRatio(v1["text-base"] as HexColor, bg)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(v1["text-base"] as HexColor, card)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(v1["syntax-keyword"] as HexColor, bg)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(v1["syntax-string"] as HexColor, bg)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(v1["syntax-primitive"] as HexColor, bg)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(v1["syntax-property"] as HexColor, bg)).toBeGreaterThanOrEqual(4.5)
  })

  test.each(["light", "dark"] as const)("%s primary button text is readable on its fill", (mode) => {
    const v2 = resolveThemeVariantV2(theme[mode], mode === "dark")

    expect(
      contrastRatio(v2["v2-text-text-contrast"] as HexColor, v2["v2-background-bg-contrast"] as HexColor),
    ).toBeGreaterThanOrEqual(4.5)
  })
})
