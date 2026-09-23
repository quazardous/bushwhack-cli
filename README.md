# bushwhack

> Let a web-chat model (Meta AI, Gemini, ChatGPT) work on a project folder on your machine — with you approving every change in your terminal.

> [!IMPORTANT]
> An independent project, not affiliated with Meta, Google or OpenAI. It drives their web
> chats, whose terms may not allow it, and what the model reads goes to their servers.
> Read [DISCLAIMER.md](./DISCLAIMER.md) before using it; security in [SECURITY.md](./SECURITY.md).

A chat model in a browser tab cannot touch your files. bushwhack gives it tools: the
model writes tool calls as code blocks in its answer, a browser extension picks them up
and hands them to a small daemon running in your project folder, and the results are
written back into the chat's message box for the model to read. Reads are free; every
write, edit, move or delete stops in your terminal for a yes or no.

Status: early. What works today: file access from meta.ai, Gemini and ChatGPT, secret files, and a web app
per project served at `http://<project>.localhost` (needs Docker and
[octopod](https://github.com/quazardous/octopod) — `octopod` on the PATH, or `BUSHWHACK_OCTOPOD` pointing at it).
The model can also look at that app's page — read it, click, fill, see its console and
requests, and get a picture of it — in a background tab the extension opens for it, and
never on any other site (see [ARCHITECTURE.md](./ARCHITECTURE.md)).

## Install

Requires Node 22+ and Chromium.

```sh
git clone https://github.com/quazardous/bushwhack-cli bushwhack && cd bushwhack
./setup.sh                 # dependencies, the extension, `bushwhack` on your PATH
```

On Windows, run `.\setup.ps1` in PowerShell instead (the service then runs as a background
process; the web app tools are untested there).

Load the extension once: `chrome://extensions` → enable **Developer mode** → **Load
unpacked** → pick `extension/dist`.

## Usage

In each folder you want a chat to work on:

```sh
bushwhack
```

The first time, it asks whether to share the folder; then it is the project's chat in the
terminal — what you type goes to the web chat bound to it, the answers and tool calls come
back — and your approvals for every project are answered there.

The first `bushwhack` command starts the service (through systemd's user manager, or in the
background) — one for all your projects. `bushwhack list` shows them, and the **pairing
code**. Then, on a meta.ai, Gemini or ChatGPT conversation:

1. Click the bushwhack icon on the chat: its panel opens over the page (× or Escape closes it),
   with your projects listed under their service. Type
   the service's pairing code under its name, once per browser — never in the chat — and pair.
2. **Use for this chat** binds the conversation to a project.
3. **Insert the tools manifest** puts the instructions for the model in the message box.
   Send it, then ask for what you want done.

The model's calls run in order; approvals appear at `bushwhack approvals`, named after
the project, with a diff for file writes. Results go back into the message box — sent
automatically if you tick *Send results automatically* in the panel.

`bushwhack serve` still serves one folder alone, from its own terminal.

What the model can see: everything in the folder except `.git/` and what your
`.gitignore` (or a `.bushwhackignore`) ignores. Those paths do not exist for it, for
reading or writing. Anything else it reads goes to the chat provider — point bushwhack at
a folder you are willing to share.

Secrets: list the files that hold them in `.bushwhack/secrets.jsonc`, e.g.
`{ "files": { "app/.env": { "format": "dotenv" } } }`. The model then sees
`STRIPE_KEY=‹secret:STRIPE_KEY›`, can ask for a variable with `secret:add`, and you type the
value in the `serve` terminal — it is never echoed, and never sent to the chat.

Without a browser, the same session can be driven from a second terminal:

```sh
bushwhack tools                        # the manifest the model gets
bushwhack call fs:list                 # one call, as the chat would send it
echo 'hello' | bushwhack call fs:write path=hello.txt
```

## Documentation

- [docs/QUICKSTART.md](./docs/QUICKSTART.md) — install, first session, secrets, the web app
  and its page, and what to do when something does not work.
- [ARCHITECTURE.md](./ARCHITECTURE.md) — the design, the call protocol, the security
  model, and why each piece is the way it is.
- [TODO.md](./TODO.md) — where the work stands and what comes next.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT. See [LICENSE](./LICENSE).
