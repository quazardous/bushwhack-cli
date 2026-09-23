# Security

bushwhack lets a model in a third-party web chat act on a folder of your machine. What
keeps it in its lane is not the prompt — a model can be talked into anything — but what
the tools let through. The full design is in [ARCHITECTURE.md](./ARCHITECTURE.md) (see
"Threat model, stated plainly"); in short:

- **Local only.** The service listens on `127.0.0.1`. A browser extension reaches a project
  only after it is paired with the service's code (typed once, in the extension's panel —
  never in a chat); a terminal acts only with the operator key the service keeps in a
  file only you can read.
- **Typed tools, one folder.** The model can only call the tools listed in its manifest,
  with arguments checked against their spec. File tools stay inside the project folder;
  ignored files, `.git/` and bushwhack's own state do not exist for them; links out of the
  folder are refused.
- **You approve changes.** Every write, edit, move, delete, secret change and app command
  waits for your yes — in a browser notification and its approval window, or in your
  terminal with `--approve-here` (unless you started it with `--yolo`). Only a click in the
  extension's own notification or window counts: not the chat page, nor the panel drawn
  over it. Secret values are typed in a terminal only.
- **Secrets stay names.** Declared secret files show names only; their values, and the
  credentials of the app bushwhack runs, are masked in everything the chat receives —
  a best effort: see [DISCLAIMER.md](./DISCLAIMER.md).
- **The app is boxed.** It runs in its own containers through octopod: the project mounted
  without `.bushwhack/`, `.git/` read-only, capabilities dropped, no internet unless you
  approved it at creation. The model can only look at that app's pages, in a tab the
  extension opens for it — never at any other site.
- **Standalone, nothing runs.** Installed `--standalone`, there is no app to box: bushwhack
  serves the project's files as they are (GET only, to its own `<project>.localhost` name,
  on `127.0.0.1`) and runs none of them. What it serves is what `fs:read` reads — never
  `.git/`, `.bushwhack/`, an ignored file or a declared secret file. The page's JavaScript
  runs in your browser, in the app's tab, like any site's.
- **Prompt injection is expected.** A file, a log or a page the model reads may try to make
  it call a tool. The limits above hold whatever it is told.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through
GitHub: **Security → Report a vulnerability** on
[the repository](https://github.com/quazardous/bushwhack-cli/security/advisories/new).
Say what you did, what you saw, and what you think it allows; a reply comes within a week.

Supported: the latest release only.
