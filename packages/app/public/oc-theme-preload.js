;(function () {
  var key = "opencode-theme-id"
  // Nothing stored means the user never picked a theme: they get the default, Lucina. A stored "oc-2"
  // is an explicit choice. Keep in sync with DEFAULT_THEME_ID in packages/ui/src/theme/context.tsx.
  var themeId = localStorage.getItem(key) || "lucina"

  var scheme = localStorage.getItem("opencode-color-scheme") || "system"
  var isDark = scheme === "dark" || (scheme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
  var mode = isDark ? "dark" : "light"

  document.documentElement.dataset.theme = themeId
  document.documentElement.dataset.colorScheme = mode
  var frame = themeId === "lucina" ? (isDark ? "#090c1e" : "#f2f2f7") : isDark ? "#080808" : "#fafafa"
  document.documentElement.style.backgroundColor = frame

  // Update theme-color meta tag to match app color scheme
  var metas = document.querySelectorAll("meta[name='theme-color']")
  if (metas.length > 0) metas[0].setAttribute("content", frame)

  if (themeId === "oc-2") return

  var css = localStorage.getItem("opencode-theme-css-" + mode)
  if (css) {
    var style = document.createElement("style")
    style.id = "oc-theme-preload"
    style.textContent =
      ":root{color-scheme:" +
      mode +
      ";--text-mix-blend-mode:" +
      (isDark ? "plus-lighter" : "multiply") +
      ";" +
      css +
      "}"
    document.head.appendChild(style)
  }
})()
