import lucinaIcon from "../assets/images/secretary-lucina.png"
import { type ComponentProps } from "solid-js"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <image href={lucinaIcon} x="0" y="2" width="16" height="16" />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <image href={lucinaIcon} x="0" y="10" width="80" height="80" />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 60" fill="none" class={props.class} aria-hidden="true">
      <text
        x="180"
        y="43"
        text-anchor="middle"
        fill="var(--icon-base)"
        font-family="-apple-system, BlinkMacSystemFont, sans-serif"
        font-size="42"
        font-weight="500"
        letter-spacing="-1.5"
      >
        Secretary Code
      </text>
    </svg>
  )
}
