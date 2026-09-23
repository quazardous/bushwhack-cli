# Contributing

Thanks for your interest in bushwhack!

## Reporting bugs

Open an [issue](https://github.com/quazardous/bushwhack-cli/issues) with:

- What you tried to do, and on which chat.
- What you expected to happen.
- What actually happened — the terminal's output, and the extension's log (in a
  development build, `npm run ext:dev -- state` prints its last lines). If the model filed
  a report, `bushwhack reports --json` gives it with the calls it named.
- `bushwhack --version`.
- Your Node and Chromium versions and your OS.

A chat answer that the extension misread is worth pasting as markdown (the chat's own
"copy" button gives it exactly).

## Security problems

Not as an issue: see [SECURITY.md](./SECURITY.md).

## Getting help

Open an issue tagged `question`.

## Sending a pull request

1. Branch off `main`, one change per branch.
2. Keep the suite green: `npm test`, and `npx tsc --noEmit -p <package>` for each package
   you touched (`-p extension` for the extension). The web app's end-to-end test needs
   Docker and [octopod](https://github.com/quazardous/octopod): a clone next to this one
   (`../octopod`), or `BUSHWHACK_OCTOPOD` pointing at an `octopod`; without them it is
   skipped. It runs its own octopod instance and never touches your edge.
3. Open the PR with the **what** and the **why**.

House rules that matter here:

- **Tests must fail on the old code.** Every refusal test (path jail, ignore rules,
  pairing, grammar) was checked by removing the guard it covers and watching it fail.
  Do the same for yours.
- **Drivers are data, not code** (and so are octopod's recipes). A chat UI changing its markup
  should cost a selector, reviewed like data. When tempted to add a knob, add a bounded
  field instead.
- No `any`, no dead code, no TODO markers in source — pending work lives in `TODO.md`.

## Adding a chat

A driver is one file in `packages/chat-drivers/src/drivers/`: which hosts it serves,
where the conversation id is in the URL, how to find finished assistant turns and their
code, where the message box is and how text goes in, how to send, how to copy an answer
as markdown, and the prompt that tells the model how to behave in that chat. Read the
selectors off the live page and say in the file when and how you observed them.

The development loop: `npm run ext:watch` rebuilds on change and reloads the extension
in the browser; `npm run chromium` starts Chromium with it; `npm run ext:dev -- …`
inspects and drives it (state, pairing, a tab's page and composer) from a terminal.

For a DevTools client (a DevTools MCP server), give the development browser a profile of
its own, in a git-ignored `.env.local`:

```sh
BUSHWHACK_CHROMIUM_PROFILE=$HOME/.local/state/bushwhack/chromium-dev
```

It is a separate browser (log into the chats there once), and your own Chromium can stay
open next to it. Connect the client by **autoConnect**: enable remote debugging in that
browser at `chrome://inspect/#remote-debugging`, then
`chrome-devtools-mcp --autoConnect --userDataDir <that profile>` — Chromium asks for your
consent on each connection. `BUSHWHACK_DEBUG_PORT=<port>` opens a port instead, without
any prompt: whatever reaches it drives that browser.

## Commit messages

Conventional Commits: `feat(scope): …`, `fix(scope): …`, `docs: …`. Subject in the
imperative, ≤ 72 characters; the body says why.

## Code of conduct

Be kind and assume good faith.
