# octopod mode: a real app, in its containers

bushwhack's default mode, [standalone](./guide.md#the-app-standalone-or-through-octopod),
serves a project's files as they are: a site in the browser, nothing run on your machine.
For more — a dev server, a build, a back-end, a database — a project's app can run in its
own containers instead, through [octopod](https://github.com/quazardous/octopod): the shared
local Traefik that serves each project at `http://<project>.localhost`.

## Install

Docker with Compose v2 (Docker Desktop on Windows), then octopod:

```sh
npm i -g @quazardous/octopod   # the scoped name: `octopod` alone on npm is another project
octopod setup                  # checks Docker, runs its API as a user service, starts its edge
```

(Or from a clone: `git clone https://github.com/quazardous/octopod && cd octopod && ./setup.sh`.)
On Windows: octopod 0.3 or later, the same `npm i -g` and `octopod setup`, or its clone's
`.\setup.ps1`.

Then switch bushwhack to it:

```sh
./setup.sh --use-octopod       # .\setup.ps1 -UseOctopod on Windows — or: bushwhack mode octopod
```

bushwhack finds octopod as `octopod` on your PATH, or wherever `BUSHWHACK_OCTOPOD` points. It
works with octopod 0.1 or later (its contract 1: `octopod version`); 0.2 or later is better:
bushwhack then masks the passwords octopod generated for the app by their values, not only by
their variables' names. `bushwhack list` says, next to each project, whether its app tools
are on — and if not, why (octopod missing, too old, or its edge not answering).

## The app

Ask the chat to create it ("create the app with app:create"). After your approval, the project
is served by its own `npm run dev` at `http://<project>.localhost`, with a database beside it
when asked (`app:create database: postgres`, on the app's own network only, its URL in
`DATABASE_URL`).

The model then works through the `app:*` tools, each change after your yes:

| Tool | What it does |
|---|---|
| `app:create` | the app's containers, from a stack (`node-app`…), optionally with a database |
| `app:status` | whether it runs, its URL — and, when it fails at start, why |
| `app:logs` | its last lines of output |
| `app:exec` | a command inside it: `npm install`, tests, a build (never a way to write files: `fs:*` does that) |
| `app:restart` | restart it — watched a few seconds, so a start that fails is said |
| `app:env` | its environment, credentials masked |
| `app:destroy` | remove it, its containers and its database; the project files stay |

While the app fails at start (dependencies not installed yet), `app:exec` still runs — in a
one-off container of it. The app has no internet access unless you approved it at creation
(`internet: true`), `.git/` is read-only for it and `.bushwhack/` hidden from it; its
credentials are masked in everything the chat receives.

And the model looks at its page with the `page:*` tools, as in standalone mode.

## Back to standalone

`bushwhack mode standalone` (or `./setup.sh --standalone`) — the service restarts. The
containers stay until `app:destroy`, or octopod removes them.
