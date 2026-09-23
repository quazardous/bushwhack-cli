# When it does not work

| You see | Do |
|---|---|
| The panel lists no project | `bushwhack list` (it starts the service); `bushwhack add` in the folder. |
| "the service refused this code" | `bushwhack list` shows the code; it survives restarts. |
| A write never comes back | It waits for your yes: a notification (look at the bushwhack icon's badge, or the panel), or the `bushwhack --approve-here` terminal. No notification shows? Your system may hide Chrome's (do-not-disturb, or notifications off for Chrome): use `bushwhack --approve-here`. |
| `secret:add` waits | A secret value is typed in a terminal only: `bushwhack --approve-here` in the project's folder. |
| The status bar says "reload this page" | The page was open before the extension was installed or updated: reload the tab. |
| The panel says "the extension was updated under this page" | Same: reload the page, then open the panel again. |
| The chat is slow, or Meta AI never writes the prompt | Its browser window is hidden or minimised: Chrome slows hidden pages, and Meta AI does not load its message box. Keep the window in sight. |
| The status bar says "handled in another tab" | The conversation is open in two tabs: bring the one you want to the front, it takes over. |
| Results stay in the message box | Auto-send is off, or you touched the message box: send them yourself. |
| A ChatGPT answer stays blank | The extension reloads the page once to read it; if it stays blank, reload it yourself. |
| `app:*` tools are missing | Standalone mode has none (`bushwhack mode`). In octopod mode, `bushwhack list` says why next to each project: octopod not installed, too old (`octopod version`), or its edge not answering (`octopod edge status`, is Docker running?). |
| `page:*` says "no page of the app is open" | Its tab was closed: `page:open` brings it back (the message says which page). |
| `page:*` from the CLI says "no browser answered" | The extension connects on its first call from a chat: send one from a bound chat first. |
| The model says a call "reached me altered" | The chat's copy of its answer dropped part of it (meta.ai drops `[t1]`-like tokens); nothing was run, and the model is told how to write it. |

Still stuck? `bushwhack reports` may hold what the chat noticed; otherwise open an
[issue](https://github.com/quazardous/bushwhack-cli/issues) — see
[CONTRIBUTING.md](../CONTRIBUTING.md).
