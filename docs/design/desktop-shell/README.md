# Secretary Code desktop shell: layout mock

Open `index.html` (static, no build). The rail switches plugins, the sun/moon button switches theme, tool lines expand on click; `?state=chat|code|computer&theme=light|dark&tools=open` picks a state.

- `chat-{light,dark}.png`: Lucina fills the window: her chat, the stage with the real avatar, tool calls collapsed to one line ("Worked on Drive · 4 steps").
- `chat-tools-expanded-{light,dark}.png`: the same turn with both tool groups opened, steps listed quietly; raw calls one click further.
- `code-{light,dark}.png`: the Code plugin: project picker, session list with states, transcript with grouped tool calls and a diff, "running on Codex · 3 min".
- `computer-{light,dark}.png`: the Computer plugin: live desktop, Watch / Take control, her step list and the question she asks before confirming.
- `chat-narrow-{light,dark}.png`: a 1100×750 window; the rail compacts and the stage narrows. Other rail items (Gallery, Films, All chats, Secrets, Server, Settings) show placeholders.

Reused from the web app as is (SecretaryIOS `web/`, branch `lucina-rs`): the tokens (`design/tokens.json`), the signed-in palette and pill rail (`character-shell.css`), bubbles, channel chips, source badges, composer, stage HUD and buttons, icons, avatar and portrait; Chat, Computer, Gallery and Films views would mount unchanged.
Added by the desktop shell: the hidden-inset titlebar with search and New chat, plugins on the rail instead of opencode panes, Lucina minimised to a top-bar pill while a plugin is open, the quiet tool-call groups (web and desktop), the Code plugin restyled OpenCode, Watch / Take control and the step list.
Light mode is new on desktop: the web chat shell is dark-only today, so light uses the light half of `design/tokens.json` with the light stage.

`reference/`: the real web app in `npm run dev:mock` (chat, chat with a job, plugins, gallery, computer) at 1440×900 and 1100×750, light and dark.
