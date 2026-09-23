# Bushwhack — architecture

A web-chat model (Meta AI, and any other chat UI) gets a workshop on the operator's
machine: **the project folder** to read and write — and, next, **one web app** built from
it behind Traefik, and **the app's page** in the browser to look at and click. The
operator approves in the terminal; the model reads back files, logs, URLs and what the
page shows.

Bushwhack is a **factory, not a deployment tool**. The model works on the files in front
of it, runs them, looks at the result, and goes round again. It never writes YAML, never
names an image, never picks a docker flag and never names a host path.

## Three families of tools

| Family | What it reaches | Who executes it | State |
|---|---|---|---|---|
| `fs:*` | the whole project folder | the daemon, in Node | **built** |
| `app:*` | the session's web app, behind the shared edge | the daemon: an [octopod](https://github.com/quazardous/octopod) recipe plus bushwhack's own layer; octopod renders, runs and routes it | **built** |
| `page:*` | the app's page, in a tab the extension opened for it | the extension's service worker, dispatched by the daemon over the relay | **built** |

Installed standalone (no Docker, no octopod), there are no `app:*` tools: the project's
files are served as they are, and `page:*` looks at them — see *Standalone* under **The app**.

Composing an environment from arbitrary modules (a database, a Python bench, …) is
octopod's (its recipes), and **not exposed to the model**: a session composes exactly one
thing, a web app, from octopod's app recipes.

## The properties that shape everything

1. **The model picks, it does not write infrastructure.** Every call is typed against a
   spec: narrow parameter types, no free-form object, unknown keys refused.
2. **The workspace is the project.** The folder `bushwhack serve` runs in is what the
   model edits (and, with `app:*`, what the app container mounts).
3. **The model can see what it built** (with `page:*`) — but only its app's page: an
   origin allowlist is the boundary.
4. **Compartmented by construction.** A session is one folder, one relay, one terminal.
   A chat page is bound to one session and cannot name another.

## Shape

```
~/code/demo/              ← you run `bushwhack serve` here: the model reads and writes all of it
├── package.json
├── app/.env              ← a declared secret file: the model sees it scrambled
├── .git/                 ← invisible to the model
└── .bushwhack/           ← session state: invisible to the model, excluded from git
    ├── pairing.json      ← the pairing code, 0600
    ├── endpoint.json     ← port + code, for CLI clients started in the same folder
    ├── calls.jsonl       ← the replay store (results as the chat saw them: masked)
    ├── secrets.jsonc     ← which files hold secrets — written by the operator only
    └── logs/
```

**Session state lives in the project, in `.bushwhack/`, invisible.** Like `.git/`, it does
not exist for any `fs:*` call, whatever the ignore files say, and it is kept out of git
through `.git/info/exclude` (the project's own `.gitignore` is not touched). Deleting the
folder deletes the session. When `app:*` mounts the project into a container, `.bushwhack/`
must be masked there too.

```
Chat page (meta.ai, …)
  │  the model writes calls as fenced code blocks
  ▼
Content script + chat driver        reads finished answers, writes results into the composer
  │  chrome.runtime message
  ▼
Background service worker           hub node; pairing codes and bindings live here
  │  ws://127.0.0.1:<port>           (no CORS, no mixed content, no key in the page)
  ▼
Relay (packages/relay, in-process)  refuses a client without the pairing code
  ▼
bushwhack daemon, in your folder    single entry point: parse, type, replay store, approval
  └─ fs:* → the project folder
```

The answer travels back the same way, and the driver **writes it into the chat's
composer** — not into the transcript: the model's context holds what was *sent*, so a DOM
injection would be invisible to it. Sending is automatic or left to the operator's click,
a setting in the panel.

### One process, two roles

`bushwhack serve` embeds the relay, registers a hub node named after the session, owns
the terminal prompt and runs the tools. `bushwhack tools` and `bushwhack call` are **hub
clients** of that same relay, emitting the envelopes the extension emits — so the
protocol is exercisable without a browser, and a future MCP server is just another
client.

## The call protocol — a pseudo-MCP in markdown

A web chat has no function-calling API: the model can only write text. The protocol is
therefore a text format that survives a chat UI, with MCP's two halves:

- **`tools/list` → the manifest.** A message rendered from the tool specs — grammar, rules,
  each tool with its typed parameters — plus the driver's chat-specific prompt (below).
  The operator inserts it into the chat once, from the panel. Rendered, never
  hand-written, so what the model reads cannot drift from what the daemon accepts.
- **`tools/call` → a call block**, in the model's answer:

  ````
  ```bushwhack
  ---
  bushwhack: fs:write
  id: c3
  path: src/app.js
  ---
  console.log('hello');
  ---end
  ```
  ````

  Frontmatter-shaped: `bushwhack: <tool>`, a model-chosen `id`, one `key: value` per line
  (JSON-quoted when needed), then optionally `---` and a **raw body** — file contents with
  nothing to escape, which is where JSON tool calls break down in web chats. The header is
  a deliberately tiny subset of YAML: no nesting, no lists, nothing a value can smuggle.
- **`---end` is mandatory.** Chats stream; a half-streamed body parses perfectly well — as
  a truncated file. The end line is the chat-independent signal that the call is complete.
- **Results** come back in the same shape (`bushwhack-result: <tool>`, `id`, `status: ok |
  error | denied`, facts as header lines, content as body), fenced with more backticks
  than any run in the content. Several results go back as one message, in call order.

The daemon is the authority: the page sends the raw text of each block, and the daemon
parses it again, types it against the spec, and refuses unknown keys, out-of-range
values and oversized bodies with a message the model can act on.

**Replay.** A call is identified by its conversation plus its id. The daemon keeps every
result; the same call seen again (page reload, re-render, extension restart) gets the
stored answer and runs nothing. The same id for a *different* call is refused. The
extension also marks delivered calls as handled per conversation, so a reloaded page does
not re-send its history — and binding a conversation marks the calls already in it as
handled first, so the past never runs.

## Chat drivers

One driver per chat UI, as **data**: a declarative spec plus one shared engine.

| Question | meta.ai (read off the live page) | Gemini (read off the live page) | ChatGPT (read off the live page) |
|---|---|---|
| Which pages? | `meta.ai`, `/prompt/<uuid>` | `gemini.google.com`, `/app/<hex id>` | `chatgpt.com`, `/c/<uuid>` (in a project too) |
| Which turns are finished? | a "streaming complete" attribute on the turn | the answer's markdown is no longer `aria-busy` | the turn has its action bar (copy) |
| What did the model write? | the turn's own **copy** button (captured in the page); rendered code as a fallback | the rendered code: its text is exact, newlines and tabs included | the turn's **copy** button; rendered code as a fallback |
| How does text get in? | a synthetic `paste` into the editor (Lexical) | `insertText`, the editing command typing goes through: its Quill editor ignores a synthetic paste | `insertText`: a long paste into its ProseMirror editor becomes an attached file |
| Pictures (page:screenshot)? | a pasted image file | a pasted image file | a pasted image file, uploaded as an attachment |
| How to send? | the send button, once enabled | the send button, once enabled | the send button, which exists only while there is text |
| What to tell the model? | a preamble and notes specific to this chat, appended to the manifest | same | same |

**Why the copy button.** Rendered code is not what the model wrote. meta.ai's highlighter
renders one element per line with no newline characters between them, and drops lines
it takes for markup — a `=======` line inside a code block simply vanishes from the DOM.
The chat's own "copy as markdown" gives the model's text exactly. A small script in the
page's world wraps the clipboard API: while the content script has raised a flag, a
clipboard write is handed over instead of reaching the clipboard, so the operator's
clipboard is never touched. Each answer is read once, and only if it contains
`bushwhack:` at all.

A driver is DOM knowledge only: no protocol, no transport, no policy. A UI redesign costs
a selector.

## The workspace

The root is the folder `serve` was started in, resolved through `realpath` once, so the
folder itself may be a symlink.

Every path in an `fs:*` call is relative and checked twice: normalized (no absolute, no
`..`), then resolved by `realpath` and checked again — the check that stops a symlink from
walking out of the folder, or into an ignored file under an innocent name. Writes go
through a temporary file and a rename, which replaces a path rather than writing through
whatever it pointed to.

**Ignored paths do not exist** — for reading *and* writing:

- `.gitignore` and `.bushwhackignore` apply with git's semantics (nested files, the
  deepest opinion wins, nothing re-included under an ignored directory).
- An ignored path answers exactly like a missing one, so the model cannot probe for it.
- It can be neither the source nor the destination of a write or a move — otherwise
  `fs:move .env env.txt` would defeat the read filter.
- Ignore files themselves are never written by the fs tools, at any depth — otherwise
  adding `!.env` to one would. The model changes them declaratively, like secret files:
  `ignore:add` appends one rule to a root ignore file (created if absent), after the
  operator's approval, and only a rule that hides more — no negation, no comment, no rule
  removed or changed, no file that is a link.
- Directories are not moved, and non-empty directories not deleted: they may hold ignored
  files the model cannot see.
- `.git/` is invisible: it holds hooks (host code execution, as you, on your next commit)
  and remote URLs that may carry tokens.

Reads are bounded (bytes per file, bytes per answer, entries per listing, matches per
search); binary files are refused.

**Pointing bushwhack at a real project is the operator's decision to hand that project to
the chat provider.** The startup banner says so.

## The app

`app:create {stack, internet}` gives the session one web app, served at
`http://<session>.localhost`. The work is split in two:

- **What the app is comes from an octopod recipe** (`node-app`: the octopod recipes
  whose id ends in `-app` are the stacks `app:create` offers): its image, built with its
  user named after the project at the operator's uid; the command that serves the project
  (`npm run dev`, `HOST=0.0.0.0`, `PORT=3000`); the project mounted at `/app`; the `dev`
  profile; nothing installed in the image — dependencies belong to the project
  (`app:exec npm install`).
- **bushwhack adds what a chat's app needs**, as a compose file of its own over the
  recipe (`policy.json`): **`.bushwhack/` hidden** (an empty read-only tmpfs over it),
  **`.git/` read-only** (a container that could write a hook would run code on the host
  at the next commit), all capabilities dropped, `no-new-privileges`, and an **internal
  network** that replaces the default one — no way out unless `internet: true` was
  approved. The declaration (`octopod.yaml`: the recipe, the project as its workspace,
  the policy file) is written to `.bushwhack/app/`, never into the project; octopod
  renders the recipe into `.bushwhack/app/.octopod/`, where the model cannot see it
  either.
- **[octopod](https://github.com/quazardous/octopod) decides how it is reached.** One Traefik for the machine on
  `127.0.0.1` (80, or 8480 when taken), routing only what octopod labelled; the app on its
  project's own *internal* edge network — reachable by Traefik, no way out to the
  internet, no way to the next project. bushwhack talks to octopod through its CLI
  (`--json`); the `app:*` tools are offered only when octopod answers at start-up.

`app:status` and `app:logs` are free; `app:restart`, `app:exec` (a command line run as
`sh -lc` inside the app — sandboxed, bounded, timed out) and `app:destroy` stop at the
terminal prompt, and `app:create` shows octopod's plan there (`octopod plan`: recipe and
digest, image and how it is built, files mounted read-write) with bushwhack's own lines
(network, what is hidden). Logs and command output are masked against declared secrets like
every other result.

### Standalone: the files, served as they are

A minimal install (`setup.sh --standalone`, recorded as `"mode": "standalone"` in
`~/.config/bushwhack/config.json`, which `bushwhack mode` reads and writes) has no octopod
and no Docker. The mode is chosen, never fallen back to: a normal install without octopod
has no app at all, and a standalone one never asks octopod, even when it is there.

- **One server for the process** (`ProjectSites`), on `127.0.0.1`, the first free port of
  47320–47329; each project at `http://<project>.localhost:<port>/`, told apart by the Host
  header — any other Host, a DNS name rebound to 127.0.0.1 included, gets a 404. GET and
  HEAD only, no CORS header, `no-store`: after an edit, the page is the edited one.
- **What it serves is the workspace's to decide** (`Workspace.served`): what `fs:read`
  reads — the jail, the ignore rules, `.git/` and `.bushwhack/` — and never a declared
  secret file, which `fs:read` shows scrambled and a page would show raw. Hidden and
  missing answer alike. A folder serves its `index.html`.
- **Nothing of the project runs on the machine**: no `npm run dev`, no build, no server
  code. There are no `app:*` tools; `page:*` looks at the site, and `page:open`'s notes tell
  the model what the site is — files only — and what to build there: what works in the
  browser alone, its data in the page (localStorage, IndexedDB, SQLite through WebAssembly).
- The site's address is the app's address everywhere else: `/health` reports it, so the
  extension finds the project's tab as it does an octopod app's.

## Secrets

The model uses secrets by **name**; it never sees a value. Values stay where the app reads
them — in the app's own files — and the operator declares those files in
`.bushwhack/secrets.jsonc` (a place the model cannot see):

```jsonc
{ "files": { "app/.env": { "format": "dotenv" } } }
```

- **A declared file is visible, scrambled**: `STRIPE_KEY=‹secret:STRIPE_KEY›`, names,
  comments and order intact — even when git ignores the file, as an `.env` usually is.
  Declaring is what protects: an undeclared `.env` follows the ordinary rules.
- **It is not edited like a file.** `fs:write`, `fs:edit`, `fs:move` and `fs:delete` refuse
  it, directly, through a symlink, or as the destination of a move. Search runs on the
  scrambled view, so a match cannot confirm a value.
- **`secret:list`** gives names and *set / empty*; **`secret:add`** asks the operator for
  the value in the `serve` terminal (typed without echo — an empty entry refuses);
  **`secret:remove`** asks for approval. The daemon rewrites the file, keeping comments and
  order; a new file is created `0600`.
- **Masking everywhere else**: every result is passed through a mask of the declared
  values before it is recorded and sent, so a value copied into another file, a log or a
  command's output reaches the chat as `‹secret:NAME›`. Values under 6 characters are left
  alone — masking `true` or `3000` would garble every output.
- Formats are pluggable; dotenv is the first. A `docker-compose` env file comes with
  `app:*`, which passes declared files to containers without the model seeing them.

## One chat page, one project

- **Discovery, then pairing.** Each daemon binds the first free port of a loopback range
  and answers `/health` with its folder, session and node id (with no CORS header: no web
  page may read it). The extension probes the range and lists what is serving. Adopting a
  session takes the pairing code `serve` printed, typed **in the extension's panel, never in
  the chat** — the relay closes any socket that registers without it, and ignores anything
  sent before registering. The code survives daemon restarts; `--new-code` rotates it.
- **The binding is keyed by chat host plus conversation id**, not by tab: reopening
  yesterday's conversation lands in the same project. A fresh chat is bound by tab until
  its first message gives it an id — and only the conversation born in that tab takes the
  binding over: navigating from the fresh chat to an old conversation ends the tab's
  binding instead, so an old conversation never becomes a project's with its old calls
  taken for new (`extension/src/arrival.ts`). A chat tab follows the conversation it shows:
  its tab group, and the service's idea of where the project's chat is open.
- **The model cannot name a session.** A call carries a tool and typed values — never a
  project, a folder, a port or a code. The worst an injected call can do is act on the
  project whose page it is in.

## Approval

Write, edit, move and delete stop at the `serve` terminal: the call, its path, and for a
write a unified diff against the current file (or the new file's content). `y`, `n`, or
`a` — approve that tool for the rest of the session. One question at a time, in call
order. Without a terminal to ask on, the answer is no.

The prompt is a speed bump, not the boundary: the boundary is the typed specs, the
workspace jail and the binding.

## The extension's state, and its messages

A service worker is stopped whenever it is idle, so nothing it must keep lives in its
memory alone.

| Where | What | Why there |
|---|---|---|
| `storage.local` | pairings (per session), services paired once for all their projects, bindings (conversation → session), which project's manifest each conversation was given, settings, the extension's node id, the last log lines; in the chat pages' content scripts, each conversation's handled calls and history | survives the worker, the browser and a reload of the extension |
| `storage.session` | the app tab of each session (page:*), the tab groups | tab and group ids restart with the browser: kept for its session only |
| memory | the relay connections, when a project's chat was last announced to its service | rebuilt on demand: a chat page asks for its status every second, which reconnects its project and announces it |

Messages between the layers:

- **content script → worker**: typed requests (`messages.ts`). The worker answers only its
  own panel page (whatever frame it is in) and the top frame of a tab on a site a driver
  claims — `accept()`; anything else is dropped.
- **The panel**: the extension's icon has no popup. On a chat, the content script draws an
  overlay over the whole page — a closed shadow root holding a × and a frame — and the
  frame is the panel page, an extension page the chat's scripts can neither read nor
  frame themselves: it is web-accessible only on the chat sites, at a per-session address
  (`use_dynamic_url`). It acts on that chat (`?tab=`). On any other page the panel opens in
  a tab of its own, with no chat to act on.
- **worker → panel**: the panel takes one snapshot when it opens; after that the worker
  pushes its state when it changes (a pairing, a binding, a connection, a chat tab), and
  the panel updates its cards in place. Nothing polls.
- **content script ↔ page hook** (MAIN world): DOM events. A secret cannot be shared with
  the page's world without the page's own scripts reading it, and the page already
  decides what the answer shows; what is guarded is that a copied text is taken only
  during a copy the content script itself triggered, and that the copy button is clicked
  only when the hook answers — never onto the operator's clipboard.

## The extension, in development

- **A development build** (`npm run ext:watch`) goes to its own folder with its own stable
  extension id (the manifest `key`; only the public half is in the repo). It compiles in
  the address and key of a **control relay** that the watch process hosts, connects to it
  on startup, and keeps the connection up with an alarm heartbeat. Through it,
  `npm run ext:dev` reads the extension's state and log, runs the panel's actions, and
  drives a chat tab (dump the page, type, send, copy an answer). Every rebuild asks the
  extension to reload itself over the same channel. Production builds carry none of this.
- **Chromium keeps serving a cached service worker** for an unpacked extension whose
  version has not changed, whatever the files say: development builds get a new fourth
  version component on every build.
- **A reloaded extension counts as "unpacked"**, which Chromium only runs with Developer
  mode on.
- `npm run chromium` starts Chromium on the operator's own profile (where the chat logins
  are) with the extension loaded, merging its one feature switch into the distribution's
  own `--disable-features` list rather than replacing it.

## The packages

| Package | What it owns |
|---|---|
| `packages/protocol` | the call grammar, result blocks, tool specs and argument typing, the manifest, fenced-block extraction from markdown, the bridge constants |
| `packages/workspace` | the project folder as the model sees it: the realpath jail, the ignore rules, the `fs:*` tools; applies the secret rules to every path |
| `packages/secrets` | declared secret files: declarations, formats (dotenv), scrambling, masking — no dependency on the rest of bushwhack |
| `packages/daemon` | `bushwhack serve` and its CLI clients: dispatcher, replay store, terminal approval and hidden input, session state, the `secret:*` tools |
| `packages/chat-drivers` | per-chat DOM knowledge, as data, and the one engine that uses it |
| `packages/hub` | `HubNode` and its transports: envelope routing, dedup, request/reply |
| `packages/relay` | `RelayServer` as a class the daemon embeds: pairing, per-client isolation, `/health` |
| `packages/page` | the `page:*` tools: specs, the origin rules, the DOM readers and actions injected into the tab, and the controller that checks the origin around each action — the browser behind an interface |
| `extension/` | the MV3 extension: service worker, content script, clipboard hook, panel, build and dev tooling |

## Designed, not built

### `app:*` — the web app (built)

Moved out of "designed": see **The app** above.

### `page:*` — the app's page (built)

The model looks at the page its app serves and acts on it, through the extension:
`page:open` (by path), `snapshot` (a bounded text outline with selectors), `query`,
`click`, `fill`, `wait`, `console`, `network`, `screenshot`. There is no `eval`.

- **One tab per session**, opened by the extension in the background; no action takes a
  tab id or a full URL. Tab ids are kept for the browser session only (they restart with
  the browser); when the extension restarts and forgets it, `page:open` takes back the app
  tab left in the project's group instead of opening another.
- **One tab group per project and window**, "bushwhack · <project>", holding the chats
  bound to it and its app tab. A tab the operator takes out is never put back, a tab in a
  group of theirs is never moved, and the group is never collapsed (a chat only loads its
  message box in a visible tab).
- **The daemon decides the origins** — the app's routes, as octopod reports them — and
  sends them with every request. The extension accepts only `http://…localhost` origins
  and only requests from the daemon of the connection they came on.
- **The origin is checked before *and after* every action**, like `realpath` after
  resolving a path: a click, a redirect or a script can move the tab while the action
  runs, and what was read from a page outside the app is thrown away, never returned.
  The browser is the operator's, logged into everything; a handler that accepted another
  origin would turn "look at your app" into "read my mail".
- **`page:*` goes through the daemon**, even though the extension executes it: one replay
  store, one terminal log, secret masking on what the page shows, and the CLI reaches the
  page exactly like the chat does (through any extension paired with the session).
- **Console and network** are recorded by a script registered for the app's origins only,
  in the page's world, from `document_start`; the extension reads its buffers and keeps
  only bounded strings and numbers.
- **Screenshots are rendered from the DOM** (`modern-screenshot`), not captured from the
  screen: the tab stays in the background and nothing else on screen can end up in the
  picture. The picture travels beside the result (`images` in the reply), never in the
  replay store; a replayed `page:screenshot` says to take a new one. A driver that takes
  pictures (`composer.images`) pastes it after the text, as the operator would. Pixels
  cannot be masked: a secret the app displays is visible in its screenshot.

## Threat model, stated plainly

- **Prompt injection is expected.** The model reads files and, later, pages and logs;
  hostile content will eventually make it emit a call. The boundary is the typed specs,
  the workspace jail, the ignore rules and the binding — not the prompt.
- **The project is genuinely exposed.** Everything not ignored can be read into a third
  party's chat. That is the tool working as designed; it is why state lives outside the
  folder, ignored files do not exist for the model, and declared secret files show names only.
- **Loopback is not private.** Any local process or extension can reach the relay's port;
  the pairing code is what makes a session answer, and `/health` sends no CORS header.
- **Automating a third-party chat UI** is the operator's call with respect to that
  service's terms. Bushwhack does not hide what it is doing.
