# Changelog

All notable changes to this project will be documented in this file.

> This is a curated, human-readable record — **not a commit log**. Each
> entry says *what changed and why it matters to a user*, in plain
> language, not *how* it was implemented. Skip internal refactors.
>
> **House style** for editors:
> - One short bullet per change. Multi-paragraph entries are only for
>   the major changes a user really needs to read in full.
> - No internal tracker IDs (`#NNN`, `PROJ-123`) unless that tracker
>   has a public link — they're noise otherwise. Mention the change,
>   not the ticket.
> - **Version bump = SemVer**: any `### Added` entry is at least
>   MINOR; `### Fixed` alone is PATCH; breaking change is MAJOR.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A minimal install, without Docker or octopod: `./setup.sh --standalone` (`.\setup.ps1 -Standalone` on Windows). The chat's app is then the project's own files, served as they are at `http://<project>.localhost:47320/`, and the `page:*` tools look at it. Nothing of the project runs on the machine, and only what `fs:read` reads is served — never `.git/`, `.bushwhack/`, an ignored file or a declared secret file. The chat is told to build what works in the browser alone (its data in the page: localStorage, IndexedDB, or SQLite through WebAssembly). Chosen at setup, never a fallback: `bushwhack mode` says the mode, `bushwhack mode octopod|standalone` changes it.
- Windows: `setup.ps1` sets bushwhack up in PowerShell — dependencies, the extension, the `bushwhack` command on the PATH (PowerShell, cmd and Git Bash). The service runs as a background process; the app tools work with Docker Desktop and an octopod that has its Windows fixes.
- `page:open` says how the load went: the console errors and the failed requests, the first few of each — a script or a stylesheet missing, a CDN unreachable, now recorded too — or that there were none. The model no longer has to ask page:console and page:network blind.
- Windows: a tray icon — the adventurer, grey while the service is stopped. Its menu lists the projects with the chat each is live in, opens a terminal in a project (`bushwhack` there, in Windows Terminal when installed), its app and its folder, copies the pairing code, opens an approvals terminal, starts the service, switches between standalone and octopod mode (after asking: the service restarts), and can start with Windows. A view through the CLI: quitting it leaves the service running. `setup.ps1` adds it to the Start menu and starts it (`-NoTray` does neither).
- `bushwhack list --json`: the projects, their chats and apps, the browsers, the pairing code and the mode, for a tool.
- A mascot: an adventurer in pixel art, fedora and machete, as the extension's icon (toolbar and extensions page, where Chrome showed a grey letter) and in the panel's header; `bushwhack` draws him in the terminal as it starts (in colour, in a terminal only; not under `NO_COLOR`).
- The panel shows the extension's version beside its name: what to give in a report, and a way to see a reload took.

### Changed

- Once the operator says no to a call, the calls after it in the same answer are not run (`status: skipped`, naming the refused one): they may have depended on it, and would only have put more questions. Sent again, they run.
- The panel's *Forget* is the service's, next to "this browser is paired", and asks first — in the panel, saying which service, how many projects go with it, and that their chats are unbound. It sat on every project, though it always forgot the whole service.
- *Send results automatically* is ticked by default: results go back to the chat without a click per round. A browser where it was unticked keeps it unticked.
- The panel's pairing code field stands out — larger, a halo until it is focused (steady under reduced motion) — takes the keyboard when nothing else has it, and pairs on Enter.

### Fixed

- `setup.sh` and `setup.ps1` took an install in standalone mode for an octopod one, and checked Docker and octopod: they read the mode with its colon.
- A terminal opened while its project's chat was in a background tab said "no browser has its chat open", and kept saying so though the chat worked: the service knew of open chats only from a heartbeat a hidden tab sends about once a minute, and a chat back after going silent was not announced again. A terminal that opens now asks the browsers at once which chats they show (`chat:who`), and a chat back after a silence is announced to the terminals.
- The first command right after the service started could wait two minutes for nothing: /health named the service as soon as its relay listened, before the service listened on it. It names it once the service answers.
- A terminal took the approvals before it listened for them: one sent at that moment was lost, and its call waited. It takes them once it listens.
- Leaving a chat terminal no longer ends on an `ERR_USE_AFTER_CLOSE` stack trace: its own leaving was taken for a lost service, and it tried to say so on a prompt already closed.
- Windows: the service could not start (it was launched through a bash script), and octopod was never found (npm installs it as a `.cmd`, which cannot be run without a shell): both are now started through node.

## [0.1.0] - 2026-09-23

First public release.

### Added

- `image:save`: a picture the model generated in its chat (Meta AI's Imagine, Gemini) saved into the project, after approval — a logo, an illustration. The extension reads it off the page when the call asks for it; the file is written as the chat made it (WebP, PNG…), and a name of the wrong type is refused with the right one.
- ChatGPT (chatgpt.com): a driver like meta.ai's and Gemini's — calls read through the answer's copy button, results typed into the message box and sent, with page:screenshot pictures as attachments.
- `report:bug` takes suggestions as well as bugs (`kind: suggestion`, 💡 in the terminal): what was unclear, what was missing, what cost the model time.
- With octopod 0.2 or later, the app's credentials are masked from what octopod says it generated (`octopod secrets`), not only guessed from variable names: a database password under any name stays hidden.
- `app:env`: the environment variables the app runs with, credentials masked (a URL's password, any variable whose name says key, token, secret, password).
- Clearer fiches, from Gemini's own feedback after building a project: when app:restart is needed (and when the dev script reloads by itself), fs:edit on large multi-line blocks (with an example), quiet flags for app:exec.
- `app:create database: postgres` (or `mariadb`, when octopod has the recipe): a database beside the app, on the app's own network only, its URL in the app's `DATABASE_URL`; its data kept with the app, out of the project files, and removed by `app:destroy`.
- `ignore:list` and `ignore:add`: the chat adds a rule to `.gitignore` or `.bushwhackignore` (creating it if absent) after your approval — declaratively, like secrets, and only in the direction that hides more: no negation, no rule removed or changed.
- bushwhack checks which octopod it works with: contract 1 (`octopod version`, octopod 0.1). An octopod missing, older, or whose edge does not answer leaves the app tools off, and `bushwhack list` and `setup.sh` say why and what to update.
- Reports gathered: `bushwhack reports --all` lists the reports of every project of the service, `--new` the ones nobody dealt with yet, `--json` for a tool; `take` or `dismiss` a report, with a note. The report:bug fiche tells the model who reads it, what to put in, what it is not for, and shows a whole example — examples in the manifest are checked to be valid calls.
- The extension's panel replaces its popup: the icon opens it over the chat, the whole width of the page, with a × (or Escape) to close it — it stays open while you work, and acts on that chat. On any other page it opens in a tab of its own. Redrawn for the width: projects as cards under their service.
- `report:bug`: the chat reports a problem with bushwhack itself — a tool misbehaving, a result that contradicts the files, a missing tool. Its title shows at once in your terminal; the report is kept in the project's `.bushwhack/reports.jsonl` with the calls it names and their results (masked), and `bushwhack reports` lists them.
- The popup shows a project's app address when it has an app, as a link that opens it in the project's tab group.
- `app:exec` works while the app is down or restarting in a loop — as it does before its dependencies are installed: the command runs in a one-off container of the app, and the result says so. `app:status` says the app fails at start, with its last lines. A failed `app:exec` says how it ended (exit code, timeout) and when the app has no internet access.
- `--yolo` on `bushwhack` (its own project's approvals) or `bushwhack approvals` (every project's): each approval is a yes, without asking — each one still shown. Secret values are still typed by you.
- A tab opened by hand on a project's app (`http://<project>.localhost`) joins the project's tab group, like one `page:open` opened; one that goes elsewhere leaves it.
- `bushwhack list` says, in colour, which projects are live in a chat right now: which chat (Meta AI, Gemini), in which browser and conversation. The chat terminal names it in its header, and says so as soon as the chat changes — a chat bound with "Use for this chat", another browser, another conversation.
- The popup lists projects under their service, and the service carries the pairing: one code field per service, not per project.
- `bushwhack serve` turns the current folder into a session a web chat can work on: list, read and search files freely; write, edit, move and delete after your approval in the terminal, with a diff for writes.
- Ignored files (`.gitignore`, `.bushwhackignore`) and `.git/` are invisible to the chat — they can be neither read nor written, and ignore files cannot be changed.
- A browser extension for meta.ai: pair a session with its code, bind a conversation to it, insert the tools manifest, and let calls run and results come back into the message box — sent automatically or by you.
- A plain-text call format the model writes in code blocks, with file contents that need no escaping; a half-written call is never run.
- `bushwhack tools` and `bushwhack call` drive a session from a terminal, without a browser.
- Several projects can be served at once, each in its own terminal, each paired separately; the popup shows which conversations are bound to each, and brings their tab forward.
- A status bar in the chat page: its colour says what the bridge is doing, arrows count what goes out and comes back, and a click opens the history of the conversation.
- Results never land in another conversation: they wait for their own, even if you switched chats while a call awaited approval.
- While you type in the chat, results wait until a few seconds after your last key, and are not sent automatically if you touched the message box.

- Secret files: declare an `.env` and the chat sees its variable names but never a value; it adds or removes variables through dedicated tools while you type the values in your terminal, without echo. Declared values are masked in everything else the chat receives.
- A web app for the session: the chat asks for `app:create`, and the project is served by its own dev script at `http://<project>.localhost`, through a shared local Traefik (octopod). Logs, restarts and one-off commands (npm install, tests) go through the same approval; the app sees neither the session's state nor a writable `.git`.
- The chat can see the app it built: `page:*` tools open it in a background tab of its own, read what it shows (text with selectors), click, fill, wait, read its console and requests, and take a picture of it that is pasted into the chat with the results. Only the app's own origin is ever read: an action that leaves it returns nothing.
- Gemini (gemini.google.com) works like meta.ai: tools manifest, calls, results sent back, screenshots pasted.
- A project's chats and its app tab share a tab group named after the project, one colour per project; tabs you move out stay out.
- The app is made of an octopod recipe (`node-app`), with bushwhack's own protections on top: its image is built with its user named after the project, at your uid, and installs nothing — dependencies stay in the project.
- `bushwhack` is the project's chat in the terminal: prompts typed there go to the web chat bound to the project, and its answers, tool calls and results come back. The first prompt a conversation gets from the terminal carries the tools manifest ahead of it, unless the conversation already had it; `/manifest` sends it again. A spinner and the time taken show while the chat answers. The terminal survives a restart of the service: it reconnects and takes back its chat and the approvals.
- Instances: another service beside the default one (`bushwhack --instance dev`), listed by `bushwhack instances`; a folder is active in one at a time. Several browsers on one service: a terminal's prompt goes to the one with the project's chat open.
- One service for all your projects: `bushwhack add` in each folder, one pairing in the extension for all of them, approvals for all of them in one terminal (`bushwhack approvals`). The first `bushwhack` command starts the service (systemd user unit, or in the background).
- Session state now lives in the project, in a `.bushwhack/` folder the chat cannot see and git ignores.

### Fixed

- An octopod that does not start (a broken install) is no longer reported as older than 0.1: `bushwhack list` gives its error and says to reinstall it. The quickstart and `setup.sh` install octopod from npm as `@quazardous/octopod` — `octopod` alone on npm is an unrelated package.

- `image:save` reads a picture its chat's page may not (meta.ai's resized pictures, served without CORS): the extension fetches it from the chat's declared picture hosts. A picture that still cannot be read keeps its rank — the model is told, instead of getting the next picture saved in its place.

- meta.ai's code block headers (the "Code" label and its buttons) no longer show in the terminal above a block the model quotes.
- meta.ai's follow-up suggestions under an answer ("Make a 32x32 favicon of this icon"…) no longer show in the terminal as the model's words.

- The terminal no longer waits forever on an answer that is only a picture (Gemini's): unchanged a few seconds, a picture answer is finished. Any answer with pictures says how many, and that `image:save` puts one in the project; one with nothing to read says so.

- ChatGPT sometimes finishes an answer but leaves it blank on screen, its calls unread until the page is reloaded. Seen for 20 seconds, the extension reloads the page once (the terminal says so) — not while results or the operator's text sit in the message box, and not twice in a row.

- `app:create` and `app:restart` watch the app for a few seconds: one that dies at start and restarts in a loop is an error, with its last lines, not "running".
- `page:open` on an error page (a 404, a bad gateway) is an error that gives the HTTP status and points to `app:status`, instead of "opened".
- A picture the chat refuses (ChatGPT's free quota) is caught before sending: the result says `image: not attached` instead of announcing a picture the model would then describe without seeing it.

- The terminal says why a call failed, on its result line — an invalid call especially, which was only "invalid call" before.
- A call whose file contents were written as a YAML header (`content: |`, then indented lines) is told where a body goes — after a `---` line, as is — instead of only that a header line is not `key: value`. That message had sent a model off rebuilding its file through the shell.
- `app:exec` refuses a command that writes a project file itself (echo or printf into it, `base64 -d`, a here-document, `tee`) and points to `fs:write` / `fs:edit`: a model had rebuilt a file in dozens of base64 chunks, breaking it on the way.

- A conversation open in two tabs is handled by one: the tab last brought to the front. The other says so instead of running the calls a second time; prompts from the terminal go to the acting tab.
- The terminal's spinner turns only while the chat is really answering or calls are running, not after the answer ended.
- Gemini: an image attachment's chip ("JPEG") no longer reads as part of the model's answer; the model is told to put every call it can decide now in one answer.
- The manifest says the project's files are for `fs:*`, not the app's `/app`, and `app:exec` sends file reads and writes to `fs:*`.
- The terminal warns that a chat in a hidden browser window runs slowly.

- The app's credentials (its database password, any key or token in its environment) are masked in everything the chat gets — `app:exec env`, a log printing its configuration, a connection error — not only in `app:env`.
- A call the model repeats word for word in a later answer gets its result again (from the daemon's store) instead of being skipped as already handled, which left the model waiting on it for good.
- A call running when the service goes away (restarted) no longer holds its chat page for a quarter of an hour, handling nothing else: the model is told at once that the call may have run, and to look before trying again.
- `app:create` finishes an app whose creation was cut short (the service restarted mid-way: its files exist, nothing runs) instead of answering that the app already exists.
- A call whose block ended early — a body holding a line of three backticks closes the fence — is answered with what went wrong instead of being ignored: the model waited for a result that never came, and nothing said so.
- A call missing its body, or with its text in a header key, is told where a body goes (after a second `---` line, up to `---end`): Gemini took three tries to file a report without it.
- A chat in a window behind others no longer crawls: Chrome slows a hidden tab's timers to about one a minute, and the page's loop read the chat, sent results and said it was there that seldom. The extension's worker now wakes the bound chat tabs every two seconds; the service keeps a silent chat 90 s, and the terminal hears of a chat change, not of every return.
- The app page's native dialogs (alert, confirm, prompt) no longer freeze it: in the tab the page tools drive, they answer at once (OK; a prompt its default value) and show in `page:console`. The model is told not to use them in the apps it builds.
- Results written while the chat is still busy (answering, or taking your own message) are sent as soon as its send button takes them, instead of staying in the message box for good and blocking the prompts that follow.
- A chat page stopped handling its calls for good when one of its requests failed in the extension (it waited for an answer that never came): every request is answered now, and the failure logged.
- Gemini's code block frame ("Code snippet" header) no longer shows in the terminal.
- A manifest sent again into a conversation that already has calls says which call ids are taken: a model starting over at c1 repeated an old call word for word, which was taken as already answered.
- A project's approvals go to the terminal following its chat, not to whichever approvals terminal opened last — and one project waiting on its operator no longer holds up another's.
- Meta AI answers in the terminal: no stray "bushwhack" line for each call block (the frame the chat draws around a code block, left behind — even while the block is still empty), and no text from its reasoning toggle.
- A new chat bound before its first message no longer hands its binding to an old conversation you navigate to from it (whose old calls would have been taken for new): only the conversation born in that tab takes it.
- Navigating in a chat tab: the tab follows the chat it shows — into its project's group, out of any group for an unbound chat — the terminal hears at once that the chat was left or joined, and the history of the conversation reached is never reported as a new answer.
- Two connections under one extension name no longer kick each other out every second: the relay tells the replaced one so, and it stays out; the extension opens one connection per relay at a time.
- `/manifest` in a chat bound before its first message (a new conversation) said "no driver for this chat".
- The answer shown in the terminal no longer starts with Gemini's hidden "Gemini said" heading, and the relay client's reconnect traces no longer land in the middle of the prompt.
- Reading an answer never touches your clipboard, including on pages opened before the extension was installed.
