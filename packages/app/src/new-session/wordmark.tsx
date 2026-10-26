import lucinaIcon from "../../../ui/src/assets/images/secretary-lucina.png"
import { useLanguage } from "@/runtime/i18n/language"
import "./wordmark.css"

export function NewSessionWordmark() {
  const language = useLanguage()

  return (
    <div data-component="new-session-wordmark" class="pointer-events-none mx-auto w-full max-w-[720px]">
      <div data-slot="wordmark-reveal" class="secretary-home-brand">
        <img class="secretary-home-symbol" src={lucinaIcon} alt="" />
        <h1>Secretary Code</h1>
        <p>{language.t("secretary.home.subtitle")}</p>
      </div>
    </div>
  )
}
