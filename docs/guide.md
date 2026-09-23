# The guide

Everything the [README](../README.md)'s quickstart leaves out: the service and its
instances, approvals, secrets, the two modes a project's app can run in, bug reports from
the chat, and bushwhack without a browser. Every command and option: [the command](./cli.md).
When something does not work: [troubleshooting](./troubleshooting.md).

## Install, in full

Requires Node 22+ and Chromium (or Chrome).

```sh
git clone https://github.com/quazardous/bushwhack-cli bushwhack && cd bushwhack
./setup.sh
```

`setup.sh` checks Node, installs the dependencies, builds the extension into
`extension/dist` and links the `bushwhack` command into `~/.local/bin` (`BIN_DIR=… ./setup.sh`
for another folder). It needs no root, and is safe to run again after a pull. Where GNOME
Shell runs, it also installs bushwhack's top bar indicator (`--no-gnome` leaves it out),
found at your next login under Wayland.

On Windows, `.\setup.ps1` in PowerShell does the same (`powershell -ExecutionPolicy Bypass -File .\setup.ps1`
where scripts are not allowed); the service then runs as a
background process, and bushwhack sits in the notification area (`-NoTray` leaves it out).

Load the extension: `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
pick `extension/dist`.

## The app: standalone, or through octopod

Each project can have a web app the chat builds and looks at. There are two ways to run it,
chosen for the whole install.

**Standalone — the default.** No Docker, nothing else to install: bushwhack serves the
project's files as they are at `http://<project>.localhost:47320/` (`bushwhack list` gives
the address), and the `page:*` tools open, read, click and screenshot them. Nothing of the
project runs on your machine: no dev server, no build, no back-end — HTML, CSS and
JavaScript in the browser, their data in the page (localStorage, IndexedDB, or SQLite
through WebAssembly), which is what the chat is told to build. `page:storage` reads that
data back. `.git/`, `.bushwhack/`, ignored files and declared secret files are not served.

**Through octopod — for a real app**: a dev server, databases, the app boxed in its
containers. It needs Docker and octopod: see [octopod mode](./octopod.md).

The mode stays across setups. `bushwhack mode` says it; `bushwhack mode octopod` and
`bushwhack mode standalone` switch — either restarts the service.

In both modes the panel shows the app's address under its project, and the model can look at
its page: `page:open`, `page:snapshot` (the page as text), `page:click`, `page:fill`,
`page:console`, `page:network`, `page:storage`, `page:screenshot` (a picture, pasted into the
chat with the results). The page opens in a background tab, in the project's tab group, and
only the app's own address is ever read.

## The service, and its projects

The first `bushwhack` command starts **the service** — one for all your projects, through
systemd's user manager (`systemctl --user status bushwhack`) or as a background process.

```sh
cd ~/projects/my-site
bushwhack
```

The first time in a folder, it says what sharing means and asks. (`bushwhack add <folder>`
shares a folder without asking; in `~` or `/`, `bushwhack` never offers to.) Add as many
folders as you like; `bushwhack list` shows them — each says whether it is live in a chat
right now, and where — and the service's **pairing code**; `bushwhack remove` takes one out.

The pairing code is what lets a browser's extension talk to the service: without it, the
service answers nothing, whatever else runs on your machine. It is typed once per browser,
in the bushwhack panel, for every project of the service — never in a chat.

Each project keeps its state in `.bushwhack/` in its folder — invisible to the model, and
kept out of git through `.git/info/exclude` (your `.gitignore` is not touched).

The chat sees everything in the folder except `.git/` and what `.gitignore` (or a
`.bushwhackignore`) ignores: those paths do not exist for it, for reading or writing.
Everything it reads goes to the chat provider — add only a folder you are willing to share.

### Instances

Another service can run beside the default one — `dev`, for working on bushwhack itself:
`bushwhack --instance dev …` (or `BUSHWHACK_INSTANCE=dev`) on any command, each instance with
its own projects, port and pairing code; `bushwhack instances` lists them. A folder is active
in one instance at a time. Several browsers can be paired with one service: a prompt from
the terminal goes to the one that has the project's chat open.

## Connecting a chat

Open a conversation on meta.ai, Gemini or ChatGPT (signed in), then click the bushwhack icon:
its panel opens over the chat, the whole width of the page (× or Escape closes it; on any
other page, it opens in a tab of its own).

1. Your projects are listed under their service. Type the service's pairing code in the
   field under its name — once per browser — and **Pair**.
2. **Use for this chat** binds this conversation to a project. The chat tab joins a tab
   group named after it.
3. **Details**, on a project's card, slide its view in: its chats, where its approvals go,
   and the `bushwhack` terminals following its chat — the red power button closes one, on a
   second click; it says so and exits. The cog, top right, opens the settings the same way.
4. **Insert the tools manifest** puts the instructions for the model in the message box, and
   you send it — or let the terminal do it: a conversation that never had the manifest gets
   it with your first prompt from `bushwhack`.

## The chat, from the terminal

Once a chat is bound to the project and open in the browser, `bushwhack` in the project's
folder is that chat's terminal: type a prompt, it goes to the web chat (whose tab comes to
the front); the model's answer comes back, with its calls (`● fs:read(src/app.ts)`) and their
results (`⎿ c3 ok`). `/manifest` sends the manifest again, `/status` says where prompts go,
`/always` lists the "always" rules, `/help`, `/quit` (or Ctrl-D). The web page stays the
source of truth: everything also shows there. A restart of the service does not end the
terminal: it reconnects on its own.

From a script: `echo "what does this project do?" | bushwhack` prints the chat's last answer.

## Approvals

Calls run in order. Reads run at once; writes, edits, moves, deletes, app commands and
secret changes wait for your yes, with a diff for file writes. Where they are asked, first
found first:

1. a terminal started with `bushwhack --approve-here` in the project's folder;
2. the `bushwhack approvals` terminal opened last (it takes every project's);
3. **the browser** holding the project's chat, else any paired browser: a notification with
   Yes and No; a click on it opens the call in a window of its own, the whole diff, with
   Yes / No and what to remember the answer for. The icon's badge counts those waiting, and the panel lists them. The
   panel only opens them, never answers them: it sits over the chat page, which could lure
   a click.

The project's terminal says where each one stands. On the chat page, the status bar shows
`>_` when a terminal follows the chat, in amber when the approvals are asked in a terminal. With nobody to answer, a call is refused
after 10 minutes. A secret value is never typed in the browser: it waits for a terminal, and
the browser says so. Once you say no, the calls after it in the same answer are skipped.
Results come back into the message box and are sent for you (*Send results automatically*,
in the panel); while you type in the chat, they wait a few seconds after your last key.

### Remembering an answer

A yes or a no can be remembered, so the next calls like it are not asked. What for is offered
from the call's path — for `fs:edit src/app/main.js`:

| Scope | Pattern |
|---|---|
| this file | `src/app/main.js` |
| the `.js` files in this folder | `src/app/*.js` |
| every `.js` file | `**/*.js` |
| every file | `**` |

`*` stands for any name within a folder, `**` for any path — nothing else. A rule on writes
covers edits too (both are *changes*); deletes and moves have their own; a tool without a
path (`app:exec`…) is remembered whole; a secret is always asked.

- **In the browser**, the approval window has *Remember the answer for*, ticked on *this
  file* for a change — the file one edits again and again — and not ticked for the rest.
- **In a terminal**, the scopes are shown with the question, numbered: `y3` says yes and
  remembers it for the third, `n1` says no to this file from now on; `y` or `n` alone answers
  this call only. `a` (always) is yes for every file.
- A call a rule answers is still shown in the terminal, with the rule. A remembered no is
  refused at once, and the model is told why.
- When several rules apply, the most precise wins; between two as precise, no wins.
- The rules are kept in the project's **`.bushwhack/approval-rules.json`** — across restarts,
  out of git, out of the model's reach — and it can be edited by hand; it is read at each
  call. A file that is not valid is said in the terminal and counts for nothing: every call
  is asked until it is fixed.

  ```json
  { "rules": [
    { "tools": "change", "pattern": "**/*.js", "answer": "yes", "at": "2026-09-23T14:02:11Z" },
    { "tools": "fs:delete", "pattern": "public/*", "answer": "no", "at": "2026-09-23T14:05:40Z" },
    { "tools": "app:exec", "answer": "yes", "at": "2026-09-23T14:06:02Z" }
  ] }
  ```

- `/always` (or `bushwhack approvals --always`) lists them; `/always forget <rule, pattern
  or tool>` (`--forget`), or `forget all`, takes them back.

### And

- `bushwhack --yolo` says yes to its own project's approvals by itself — each still shown;
  other projects' are asked, and secret values are still yours to type.
- Every decision, yours or a rule's, is kept in the project's `.bushwhack/approvals.jsonl`:
  `bushwhack approvals --log`.

## Secrets

Declare the files that hold them in `.bushwhack/secrets.jsonc`:

```jsonc
{ "files": { ".env": { "format": "dotenv" } } }
```

The model then sees `STRIPE_KEY=‹secret:STRIPE_KEY›`. It asks for a variable with
`secret:add`, and you type the value in your terminal, without echo — it is never sent to the
chat. Declared values are masked in everything else the chat receives, and so are the
credentials of the app bushwhack runs.

## Pictures

A chat that generates pictures (Meta AI, Gemini) can put one in the project:
`image:save path=public/logo.webp` saves the latest it generated (`image: 2` the one before),
after your approval, as the chat made it — the file named after its real type.

## When the chat finds a bug in bushwhack

The chat can report one with `report:bug` (or make a suggestion): its title shows at once in
your terminal, and `bushwhack reports` (in the project's folder) lists them — `bushwhack
reports 2` shows one in full, with the calls it names and their results. `bushwhack reports
--all --new` gathers the new ones of every project; `bushwhack reports take|dismiss
<project>:<n> [note]` says what became of one (`--json` for a tool).

## Without a browser

The same project, from a terminal in its folder:

```sh
bushwhack tools                                  # the manifest the model gets
bushwhack call fs:list                           # one call, as the chat sends it
echo 'hello' | bushwhack call fs:write path=hello.txt
```

`bushwhack serve` is the older way: one folder, its approvals in its own terminal.
