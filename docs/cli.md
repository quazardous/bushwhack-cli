# The `bushwhack` command

Every command and option, in one place. For a first project, the [README](../README.md)
walks you through; the [guide](./guide.md) explains how the pieces fit.

```text
bushwhack [command] [options]
```

The first command that needs the service starts it (through systemd's user manager where
there is one, else as a background process): there is nothing to start by hand.

## In a project's folder

### `bushwhack`

Talk to the project's chat from this terminal.

- In a folder not shared yet, it says what sharing means and asks — `y` shares it. Never in
  `~` or `/`.
- Then it shows your projects and the **pairing code**, and waits for a prompt: what you
  type goes to the web chat bound to this project, and its answer comes back here, with its
  calls and their results.
- **Approvals are asked in the browser**: a notification with Yes and No, and a click on it
  opens the whole diff with Yes / No and what to remember the answer for. The terminal says where each one stands
  (`⏳ c12 fs:write — waiting for your yes in the browser`, then `✓ accepted`).
- In a folder that is not a project (and not to be one), it becomes an approvals terminal,
  like `bushwhack approvals`.

In the terminal:

| Type | For |
|---|---|
| a prompt | send it to the chat |
| `!<command>` | run it in the project's folder with your shell; its output shows here, then the command and its output go to the chat — declared secrets masked |
| `/manifest` | send the chat the tools manifest again (the first prompt carries it anyway) |
| `/status` | the instance, the browsers, where prompts and approvals go, the projects |
| `/always` | the answers remembered here; `/always forget <rule, pattern or tool>`, `/always forget all` |
| `/help` | this list |
| `/quit`, Ctrl-D | leave |

From a script, a prompt on stdin gets the chat's finished answer on stdout:

```sh
echo "what does this project do?" | bushwhack
```

### `bushwhack --approve-here`

The same, with the approvals asked **in this terminal** instead of the browser — with the
diff and what the answer may be remembered for, numbered:

```text
│ remember it for: 1 src/app/main.js · 2 src/app/*.js · 3 **/*.js · 4 **
└ approve? [y]es / [n]o — or y1…y4 / n1…n4 to remember it:
```

`y` or `n` answers this call only; `y3` says yes and remembers it for every `.js` file; `n2`
says no to the `.js` files of that folder from now on. `a` is yes for every file. It takes this project's approvals, and the
other projects' when no other terminal takes them.

### `bushwhack --yolo`

Says yes to its own project's approvals by itself — each still shown, in red. Other
projects' are asked as usual, and secret values are still yours to type. Implies
`--approve-here`.

## Projects

| Command | Does |
|---|---|
| `bushwhack add [folder]` | share a folder with web chats, without asking (the current one by default) |
| `bushwhack remove [folder]` | stop sharing it (its files stay) |
| `bushwhack list` | the projects — live in a chat or not, and where — their app's address, and the pairing code |
| `bushwhack list --json` | the same, for a program (the Windows tray and the GNOME indicator read it) |

## Approvals

Reads run at once; writes, edits, moves, deletes, app commands and secret changes wait for a
yes. Where they are asked, first found first:

1. a `bushwhack --approve-here` (or `--yolo`) terminal on that project;
2. the `bushwhack approvals` terminal opened last;
3. the browser that has the project's chat open, then any paired browser.

With nobody to answer, a call is refused after 10 minutes. A **secret value** is never typed
in the browser: it waits for a terminal (`bushwhack --approve-here`), and the browser says so.

| Command | Does |
|---|---|
| `bushwhack approvals` | answer every project's approvals in this terminal |
| `bushwhack approvals --yolo` | say yes to all of them by itself, each shown |
| `bushwhack approvals --always` | the answers remembered, per project |
| `bushwhack approvals --forget <rule\|pattern\|tool\|all>` | take them back: asked again |
| `bushwhack approvals --log` | each project's last decisions: what, yes or no, and who said it (`operator`, `browser`, `rule` and which, `yolo`, `nobody`) |

Every decision is kept in the project's `.bushwhack/approvals.jsonl`; the answers remembered,
in its `.bushwhack/approval-rules.json` — see [remembering an answer](./guide.md#remembering-an-answer).

## The app

| Command | Does |
|---|---|
| `bushwhack mode` | which mode serves the projects' apps |
| `bushwhack mode standalone` | the project's files served as they are, nothing run (the default) |
| `bushwhack mode octopod` | the app in its containers, through [octopod](./octopod.md) |

Changing the mode restarts the service: every chat reconnects, and a call running then is lost.

## Bug reports from the chat

| Command | Does |
|---|---|
| `bushwhack reports` | this project's reports (`report:bug`) |
| `bushwhack reports --all --new` | the new ones, of every project (`--json` for a program) |
| `bushwhack reports <n>` | one in full, with the calls it names; `<project>:<n>` from anywhere |
| `bushwhack reports take <ref> [note]` | say it is being worked on |
| `bushwhack reports dismiss <ref> [note]` | say it is not a bug, or not one to fix |

## Without a browser

| Command | Does |
|---|---|
| `bushwhack tools` | print the tools manifest the chat is given |
| `bushwhack call <tool> [key=value …]` | run one call as the chat would; a body (a file's content) is read from stdin |
| `bushwhack serve [--new-code]` | the older way: this folder alone, its own pairing code (`--new-code`: a fresh one), approvals in this terminal |

```sh
bushwhack call fs:list
echo 'hello' | bushwhack call fs:write path=hello.txt
```

## The service

| Command | Does |
|---|---|
| `bushwhack daemon` | run the service in the foreground (what systemd runs) |
| `bushwhack instances` | the instances: running or not, their projects and browsers |
| `bushwhack version` | the version (`--version` too) |
| `bushwhack help` | the short list of commands |

### `--instance <name>`

On any command: work with that instance — another service beside the default one, with its
own projects, port and pairing code (`dev`, for working on bushwhack itself). By default,
the instance serving the current folder, else `default`. `BUSHWHACK_INSTANCE=<name>` does
the same.

## Environment

| Variable | For |
|---|---|
| `BUSHWHACK_INSTANCE` | the instance, as `--instance` |
| `BUSHWHACK_OCTOPOD` | the `octopod` command to run, when it is not on the `PATH` |
| `XDG_CONFIG_HOME` | where the mode is kept (`bushwhack/config.json`; `~/.config` by default) |
| `XDG_STATE_HOME` | where the service keeps its state (`bushwhack/`; `~/.local/state` by default) |
| `BIN_DIR` | for `setup.sh` / `setup.ps1`: where to put the `bushwhack` command (`~/.local/bin`) |
