// @refresh reload

import "./diagnostics"
import "./styles.css"
import { render } from "solid-js/web"
import { api } from "./api"
import { DesktopApp } from "./desktop-app"
import { startDesktopMenu } from "./platform/menu"
import { startDeepLinks } from "./startup/deep-links"
import { requireRendererRoot } from "./startup/root"
import { desktopVersion, initializeSentry } from "./startup/sentry"
import secretaryCopy from "./secretary/en.json"

const root = requireRendererRoot()

const version = desktopVersion()

startDesktopMenu(api)

startDeepLinks(api)

render(() => <DesktopApp api={api} version={version} />, root)

const lucina = document.createElement("button")
lucina.className = "secretary-companion-button"
lucina.textContent = secretaryCopy.name
lucina.title = secretaryCopy.openLucina
lucina.setAttribute("aria-label", secretaryCopy.openLucina)
lucina.addEventListener("click", () => void window.electron.secretary.open())
document.body.append(lucina)

void initializeSentry(version)
