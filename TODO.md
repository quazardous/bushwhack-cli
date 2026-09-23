# TODO — handoff

State as of 2026-09-22. Read `ARCHITECTURE.md` first: it holds the design and the
reasons. This file holds what is done, what is next, and what has already been ruled out
so you do not re-derive it.

## Where it stands

**Milestone 1 works end to end: a meta.ai conversation reads and edits a project folder.**
Tried live: the model listed the project, read files, created a file and edited another
(approved in the terminal), and re-read them to check its own work.

- `packages/protocol`, `packages/workspace`, `packages/daemon`, `packages/chat-drivers`,
  `packages/hub`, `packages/relay`: `npm test` (170 tests) and
  `npx tsc --noEmit -p packages/<pkg>` are green.
- `extension/`: MV3, `npx tsc --noEmit -p extension` green; exercised live through the
  dev control channel (no unit tests of its own yet — see below).
- `bin/bushwhack serve | tools | call`.

Built since: secret files (`packages/secrets`), and `app:*` on top of octopod (a separate
repository: the shared Traefik and the composition of Docker projects).

Built since: `page:*` (`packages/page`), the app's page seen and driven through the
extension, screenshots pasted back into the chat.

Built since: a second driver, Gemini — read from the DOM (exact there), written with `insertText`.

Not built: drivers beyond meta.ai and Gemini, stacks other than Node.

## Next, in order

1. **Extension tests.** The service worker's binding/pairing logic and the content
   script's loop are only exercised live. Put `chrome.*` behind a small interface (as
   the engine already is for the DOM) and test: a bind marks history handled; a result
   waits for an empty composer; an orphaned script stops; a replayed call is still
   written.
2. **Popup polish.** The relay dots, pairing and binding work; the popup has no way to see
   the extension's log or the last results — the dev channel has both.
3. **Third driver** (chatgpt.com or claude.ai). Gemini proved the spec needs little: a
   composer kind (`insertText`) was the only addition. Read the selectors off the live
   page with `npm run ext:dev -- tab <id> probe <selector>` and the DevTools port.
4. **More stacks** (`app-python`…) and **module composition** (a database next to the app)
   on the same octopod edge.
5. **An MCP server** as another hub client of `serve`, so a terminal agent can drive the
   same session.

## Settled — do not redo this reasoning

- **The answer goes into the chat COMPOSER, never into the transcript.** The model's
  context holds what was sent.
- **Read the model's answer through the chat's copy button, not the rendered DOM.**
  meta.ai's highlighter renders one element per line with no newlines, renders an empty
  line as a lone `\n`, and drops a `=======` line from a code block entirely. The DOM
  reader (with the driver's `lines` selector) is the fallback, not the source. A
  side effect that mattered: DOM text changes with rendering, and the replay store keys
  calls by text — a re-render could turn a replay into "id already used".
- **Capture the copy, do not use the clipboard.** A MAIN-world script wraps
  `navigator.clipboard.writeText`/`write` and `execCommand('copy')`; while the content
  script's flag is up, the text is handed over and the operator's clipboard is untouched.
- **Driver selectors are language-independent.** meta.ai's buttons are labelled in the
  UI language; the copy button is found by position (its `<canvas>` only exists after it
  has animated — do not select on it).
- **`---end` is mandatory in the grammar.** A half-streamed body parses as a truncated
  file; the chat's "streaming complete" flag is a second guard, not the first.
- **Ignored paths do not exist, both ways.** Filtering reads alone is defeated by a move or
  by editing an ignore file.
- **Session state lives in the project, in `.bushwhack/`, hidden like `.git/`** (reversed
  from "outside the project": deleting the folder should delete the session). The price is
  paid by `app:*`: `.bushwhack/` must be masked in any container that mounts the project.
- **Secrets are declared files, not a store.** Values stay in the app's own files; the
  model sees them scrambled, changes them only through `secret:*`, and every result is
  masked before it is recorded or sent. A scrambled view is never written back — no value
  can be lost to a badly copied placeholder.
- **Hidden input is a raw-mode read**, not readline: readline's echo goes through
  internals, and overriding `_writeToOutput` did not stop it (seen live).
- **`fetch` and the relay connection belong to the service worker**, not the content
  script: mixed content and Private Network Access, and no key in the page.
- **The relay accepts nothing before registration, and a client is connected only once
  the relay says `registered`.** A transport that announced itself on socket open sent
  envelopes ahead of its registration (dropped), and a wrong pairing code looked like a
  success.
- **The terminal prompt is a speed bump, not the boundary.**
- **Chromium and extensions, learned the hard way:**
  - it keeps running a cached service worker while the extension version is unchanged —
    dev builds bump a fourth version component every build;
  - a production and a development build must not share an id — separate folders, and a
    manifest `key` per environment;
  - `chrome.runtime.reload()` turns a command-line extension into an unpacked one, which
    runs only with Developer mode on;
  - remote debugging is refused on the default profile, and the dev profile must be the
    operator's own (chat logins) — so the extension is driven through its own dev relay;
  - `--disable-features` is last-wins: merge into the distribution's list;
  - a content script survives an extension reload as an orphan whose `chrome.*` calls
    throw: it must detect that and stop, and the worker re-injects into open chat tabs.
- **The relay matches `prefix:*` patterns only** (`ext:*`, not `ext:dev-*`).
- **Several projects at once work** (tried live: two sessions, two conversations, calls in
  parallel, each landing only in its own terminal). What that took:
  - results are held per conversation and written only into their own — a call waiting
    for approval must not land in the chat the operator moved to;
  - history and send state follow the conversation on screen, not the tab;
  - meta.ai finishes rendering a page only while its tab is visible (it waits for
    animation frames): a chat reloaded in the background has no editor until shown, and
    the extension waits — it adds nothing to a page that has not hydrated;
  - a page loaded before the extension has no clipboard hook: the content script checks
    for it before clicking a copy button, or the click would reach the real clipboard.
- **`.localhost`, not `.local`**, for `app:*` routing, and HTTP only: a secure context
  already, no certificate to install.
- **Composing is octopod's, not bushwhack's.** An octopod recipe says what the app is;
  bushwhack adds only its chat-specific layer (a compose file over the recipe); octopod's
  shared edge routes it, filtered on one exact label (without it, a Traefik adopts every
  other project's routers — reproduced on this machine), each project on its own internal
  edge network.
- **In the app container, `.bushwhack/` is an empty read-only tmpfs and `.git/` is
  read-only**, both checked against real docker. A workspace block starts in `/app`
  (images rarely set a working directory; `npm run dev` from `/` finds nothing).

## Known issues

- **Pairing is lazy**: a paired session connects on its first call, so the popup shows it
  grey until then — and a `page:*` call from the CLI finds no browser (after a minute)
  until a chat bound to the session has sent a call. Connecting eagerly on worker start
  would fix both.
- **A result the operator clears from the composer is lost** for the model (the calls are
  marked handled). A "resend last results" action in the popup would cover it.
- **`python-lab`'s `/work` is probably unwritable** (named volume at a path absent from
  its image, created `root:root`, block runs as `1000:1000`). Unexposed; fix or turn into
  an `app-python` stack when it comes back.

## Open questions

- **Approval granularity for writes.** `a` (always, per tool, per session) exists; a
  path-prefix approval might fit better.
- **Auto-send by default?** Off today. On is smoother; off keeps a human glance on what
  goes back to the provider.
- **Pinning images** in octopod's recipes (`unpinned: true` everywhere today).

## House rules that bit here

- Blocks and drivers are DATA, not code.
- Tests must fail on the old code. Every refusal test was checked by removing its guard.
- No `any`, no dead code, no TODO markers in source.
- Public repository: English everywhere, no references a stranger cannot follow.
