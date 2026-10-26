import { type ComponentProps } from "solid-js"

export function Wordmark(
  props: Pick<ComponentProps<"svg">, "class"> & { fade?: boolean; muted?: boolean; outline?: boolean },
) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 129" fill="none" class={props.class} aria-hidden="true">
      <text
        x="360"
        y="88"
        text-anchor="middle"
        fill="currentColor"
        opacity={props.muted === false ? 1 : 0.6}
        font-family="-apple-system, BlinkMacSystemFont, sans-serif"
        font-size="76"
        font-weight="500"
        letter-spacing="-3"
      >
        Secretary Code
      </text>
    </svg>
  )
}
