import { createEffect, For, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"

const target = ["s", "e", "c", "r", "e", "t", "a", "r", "y"] as const

const choices = ["s", "e", "c", "r", "t", "a", "y"] as const

export function AnimatedWordmark(props: { active: boolean }) {
  const [state, setState] = createStore({ letters: [...target] })
  const timers = new Set<ReturnType<typeof setTimeout>>()

  createEffect(
    on(
      () => props.active,
      (active) => {
        timers.forEach(clearTimeout)
        timers.clear()

        if (!active || matchMedia("(prefers-reduced-motion: reduce)").matches) {
          setState("letters", [...target])

          return
        }

        const starts = target.map(() => choices[Math.floor(Math.random() * choices.length)])
        const settles = target.map(() => 6 + Math.floor(Math.random() * 8))
        const last = Math.max(...settles)
        setState("letters", starts)

        Array.from({ length: last }, (_, index) => index + 1).forEach((tick) => {
          const timer = setTimeout(() => {
            setState(
              "letters",
              target.map((letter, index) =>
                tick >= settles[index] ? letter : choices[Math.floor(Math.random() * choices.length)],
              ),
            )
            timers.delete(timer)
          }, tick * 75)

          timers.add(timer)
        })
      },
    ),
  )

  onCleanup(() => timers.forEach(clearTimeout))

  return (
    <svg class="settings-about-wordmark" viewBox="0 0 264 42" aria-hidden="true">
      <defs>
        <symbol id="settings-about-letter-o" viewBox="0 0 24 42">
          <path class="settings-about-letter-shadow" d="M18 30H6V18H18V30Z" />
          <path d="M18 12H6V30H18V12ZM24 36H0V6H24V36Z" />
        </symbol>
        <symbol id="settings-about-letter-p" viewBox="0 0 24 42">
          <path class="settings-about-letter-shadow" d="M18 30H6V18H18V30Z" />
          <path d="M6 30H18V12H6V30ZM24 36H6V42H0V6H24V36Z" />
        </symbol>
        <symbol id="settings-about-letter-e" viewBox="0 0 24 42">
          <path class="settings-about-letter-shadow" d="M24 24V30H6V24H24Z" />
          <path d="M24 24H6V30H24V36H0V6H24V24ZM6 18H18V12H6V18Z" />
        </symbol>
        <symbol id="settings-about-letter-n" viewBox="0 0 24 42">
          <path class="settings-about-letter-shadow" d="M18 36H6V18H18V36Z" />
          <path d="M18 12H6V36H0V6H18V12ZM24 36H18V12H24V36Z" />
        </symbol>
        <symbol id="settings-about-letter-c" viewBox="0 0 24 42">
          <path class="settings-about-letter-shadow" d="M24 30H6V18H24V30Z" />
          <path d="M24 12H6V30H24V36H0V6H24V12Z" />
        </symbol>
        <symbol id="settings-about-letter-s" viewBox="0 0 24 42">
          <path d="M24 12H6V18H24V36H0V30H18V24H0V6H24V12Z" />
        </symbol>
        <symbol id="settings-about-letter-r" viewBox="0 0 24 42">
          <path class="settings-about-letter-shadow" d="M18 18H6V12H18V18Z" />
          <path d="M24 12H6V36H0V6H24V12Z" />
        </symbol>
        <symbol id="settings-about-letter-t" viewBox="0 0 24 42">
          <path d="M12 0V6H24V12H12V30H24V36H6V12H0V6H6V0H12Z" />
        </symbol>
        <symbol id="settings-about-letter-a" viewBox="0 0 24 42">
          <path class="settings-about-letter-shadow" d="M18 30H6V24H18V30Z" />
          <path d="M24 36H0V18H18V12H0V6H24V36ZM18 24H6V30H18V24Z" />
        </symbol>
        <symbol id="settings-about-letter-y" viewBox="0 0 24 42">
          <path class="settings-about-letter-shadow" d="M18 24H6V12H18V24Z" />
          <path d="M0 6H6V24H18V6H24V42H0V36H18V30H0V6Z" />
        </symbol>
        <symbol id="settings-about-letter-d" viewBox="0 0 24 42">
          <path class="settings-about-letter-shadow" d="M18 30H6V18H18V30Z" />
          <path d="M18 12H6V30H18V12ZM24 36H0V6H18V0H24V36Z" />
        </symbol>
      </defs>
      <For each={state.letters}>
        {(letter, index) => (
          <use href={`#settings-about-letter-${letter}`} x={index() * 30} width="24" height="42" />
        )}
      </For>
    </svg>
  )
}
