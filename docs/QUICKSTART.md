# Quickstart

From nothing to a meta.ai, Gemini or ChatGPT chat working on one of your folders, then serving and looking at
a web app.

## 1. Install (once)

Requires Node 22+ and Chromium (or Chrome).

```sh
git clone https://github.com/quazardous/bushwhack-cli bushwhack && cd bushwhack
./setup.sh
```

`setup.sh` checks Node, installs the dependencies, builds the extension into
`extension/dist` and links the `bushwhack` command into `~/.local/bin` (`BIN_DIR=… ./setup.sh`
for another folder). It needs no root, and is safe to run again after a pull.

Load the extension: `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
pick `extension/dist`.

For the web app tools (optional): Docker with Compose v2, and
[octopod](https://github.com/quazardous/octopod) — the shared local Traefik that serves each project at
`http://<project>.localhost`:

```sh
npm i -g @quazardous/octopod   # the scoped name: `octopod` alone on npm is another project
octopod setup                  # checks Docker, runs its API as a user service, starts its edge
```

Or from a clone: `git clone https://github.com/quazardous/octopod && cd octopod && ./setup.sh`.

On Windows, with Docker Desktop running: octopod 0.3 or later (the same `npm i -g` and
`octopod setup`), or its clone's `.\setup.ps1`, which also puts its tray in the Start menu —
the tray runs octopod's API, which its console reads.

bushwhack finds it as `octopod` on your PATH, or wherever `BUSHWHACK_OCTOPOD` points, and
works with octopod 0.1 or later (its contract 1: `octopod version`); 0.2 or later is better:
bushwhack then masks the passwords octopod generated for the app by their values, not only
by their variables' names. Run `./setup.sh` (`.\setup.ps1` on Windows) in
bushwhack again afterwards to check it is seen. Without it, the chat gets
the file and secret tools only.

### Or a minimal install: standalone

Without Docker or octopod, a chat can still build a site it looks at:

```sh
./setup.sh --standalone          # .\setup.ps1 -Standalone on Windows
```

The project's files are then served as they are at `http://<project>.localhost:47320/`
(`bushwhack list` gives the address), and the `page:*` tools open, read, click and
screenshot them. Nothing of the project runs on your machine: no dev server, no build, no
back-end, no `app:*` tools — HTML, CSS and JavaScript in the browser, their data in the page
(localStorage, IndexedDB, or SQLite through WebAssembly), which is what the chat is told to
build. `.git/`, `.bushwhack/`, ignored files and declared secret files are not served.

The mode stays across setups. `bushwhack mode` says it; `bushwhack mode octopod` goes back
to the app in containers (install octopod first), `bushwhack mode standalone` the other way
— either restarts the service.

## 2. Add a project

In the folder the chat should work on:

```sh
cd ~/projects/my-site
bushwhack
```

The first time in a folder, it says what sharing means and asks; then it stays open as the
terminal where your approvals come — for every project. (`bushwhack add <folder>` shares a
folder without asking; in `~` or `/`, `bushwhack` never offers to.)

The first `bushwhack` command starts **the service** — one for all your projects, through
systemd's user manager (`systemctl --user status bushwhack`) or as a background process.
Add as many folders as you like; `bushwhack list` shows them — each says whether it is live
in a chat right now, and where — and the service's **pairing code**; `bushwhack remove` takes
one out. The pairing code is what lets a browser's extension talk to the service: without
it, the service answers nothing, whatever else runs on your machine. It is typed once per
browser, for every project of the service. Each project keeps its state in `.bushwhack/` in its
folder — invisible to the model, and kept out of git through `.git/info/exclude` (your
`.gitignore` is not touched).

The chat sees everything in the folder except `.git/` and what `.gitignore` (or a
`.bushwhackignore`) ignores. Everything it reads goes to the chat provider: add only a
folder you are willing to share.

Writes and the other calls that need your yes wait in that terminal (or in
`bushwhack approvals`: the terminal opened last gets them), named after their project.
A project's approvals go to the terminal following its chat (`bushwhack` in its folder),
else to the approvals terminal opened last. With nobody there, they are refused after a
while. `bushwhack --yolo` says yes to its own project's by itself — each still shown;
other projects' are asked, and secret values are still yours to type.

### Instances

Another service can run beside the default one — `dev`, for working on bushwhack itself:
`bushwhack --instance dev …` (or `BUSHWHACK_INSTANCE=dev`) on any command, each instance
with its own projects, port and pairing code; `bushwhack instances` lists them. A folder is
active in one instance at a time, and `bushwhack` in a shared folder goes to the one
serving it. Several browsers can be paired with one service: a prompt from the terminal
goes to the one that has the project's chat open.

## 3. Connect a chat

Open a conversation on meta.ai, Gemini or ChatGPT (signed in), then click the bushwhack icon:
its panel opens over the chat, the whole width of the page (× or Escape closes it; on
any other page, it opens in a tab of its own).

1. Your projects are listed under their service. Type the service's pairing code in the
   field under its name — once per browser, for all its projects; never in the chat — and
   **Pair**.
2. **Use for this chat** binds this conversation to a project. The chat tab joins a tab
   group named after it.
3. **Insert the tools manifest** puts the instructions for the model in the message box.
   Send it.
4. Ask for what you want: "list the project", "add a README", …

Calls run in order. Reads run at once; writes, edits, moves and deletes wait for `y` at
`bushwhack approvals`, with a diff. Results come back into the message box — and are sent
for you if **Send results automatically** is ticked. While you type in the chat, results
wait a few seconds after your last key.

`bushwhack serve` is the older way: one folder, its approvals in its own terminal.

## The chat, from the terminal

Once a chat is bound to the project and open in the browser, `bushwhack` in the project's
folder is that chat's terminal: type a prompt, it goes to the web chat (whose tab comes to
the front); the model's answer comes back, with its calls (`● fs:read(src/app.ts)`) and
their results (`⎿ c3 ok`). A conversation that never had the tools manifest gets it with
your first prompt, in the same message; `/manifest` sends it again. Approvals are answered
there too. `/help`, `/status`, `/quit` (or Ctrl-D). The web page stays the source of truth:
everything also shows there. A restart of the service does not end the terminal: it
reconnects on its own.

From a script: `echo "what does this project do?" | bushwhack` prints the chat's last
answer.

## 4. Secrets

Declare the files that hold them in `.bushwhack/secrets.jsonc`:

```jsonc
{ "files": { ".env": { "format": "dotenv" } } }
```

The model then sees `STRIPE_KEY=‹secret:STRIPE_KEY›`. It asks for a variable with
`secret:add`, and you type the value at `bushwhack approvals`, without echo. Declared
values are masked in everything else the chat receives.

## 5. A web app, and its page

With octopod available, ask the chat to create the app ("create the app with app:create").
After your approval, the project is served by its own `npm run dev` at
`http://<project>.localhost`. The model installs dependencies (`app:exec npm install`),
reads logs and restarts the app through the same approvals.

The panel shows the app's address under its project: a click opens it, in the project's
tab group. While the app fails at start (dependencies not installed yet), `app:exec` still
runs — in a one-off container of it — and `app:status` shows why it fails.

Then it can look at it: `page:open`, `page:snapshot` (the page as text), `page:click`,
`page:fill`, `page:console`, `page:network`, `page:screenshot` (a picture, pasted into
the chat with the results). The page opens in a background tab, in the project's group,
and only the app's own address is ever read.

## When the chat finds a bug in bushwhack

The chat can report one with `report:bug`: its title shows at once in your terminal, and
`bushwhack reports` (in the project's folder) lists them — `bushwhack reports 2` shows one
in full, with the calls it names and their results. `bushwhack reports --all --new` gathers
the new ones of every project; `bushwhack reports take|dismiss <project>:<n> [note]` says
what became of one (`--json` for a tool).

## Without a browser

The same project, from a terminal in its folder:

```sh
bushwhack tools                                  # the manifest the model gets
bushwhack call fs:list                           # one call, as the chat sends it
echo 'hello' | bushwhack call fs:write path=hello.txt
```

## When it does not work

| You see | Do |
|---|---|
| The panel lists no project | `bushwhack list` (it starts the service); `bushwhack add` in the folder. |
| "the service refused this code" | `bushwhack list` shows the code; it survives restarts. |
| A write never comes back | Nobody at `bushwhack approvals`: open it in a terminal. |
| The status bar says "reload this page" | The page was open before the extension was installed or updated: reload the tab. |
| The chat is slow, or Meta AI never writes the prompt | Its browser window is hidden or minimised: Chrome slows hidden pages, and Meta AI does not load its message box. Keep the window in sight. |
| The status bar says "handled in another tab" | The conversation is open in two tabs: bring the one you want to the front, it takes over. |
| Results stay in the message box | Auto-send is off, or you touched the message box: send them yourself. |
| `app:*` tools are missing | `bushwhack list` says why next to each project: octopod not installed, too old (bushwhack needs its contract 1: `octopod version`), or its edge not answering (`octopod edge status`, is docker running?). |
| `page:*` from the CLI says "no browser answered" | The extension connects on its first call from a chat: send one from a bound chat first. |
