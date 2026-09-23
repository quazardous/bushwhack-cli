# Disclaimer

bushwhack is an independent project. It is **not affiliated with, endorsed by or supported
by Meta, Google or OpenAI**; "Meta AI", "Gemini" and "ChatGPT" are named only to say which
web chats it works with.

**It drives their web interfaces.** Its browser extension reads the answers in a chat page
and writes into its message box, as you would. A chat's terms of service may not allow
that. Whether you may use bushwhack with a given chat and account is yours to check, and
the responsibility is yours: use it with your own accounts, and within their rules. A
chat may change its page at any time and break bushwhack until its driver is updated.

**What the chat reads leaves your machine.** Every file the model reads, every result it
gets — command output, app logs, a page's text or picture — goes into the chat, and so to
the chat's provider, under that provider's terms. bushwhack masks the secret values it
knows of (the ones you declared, the credentials of the app it runs), but masking is a
best effort, not a guarantee. Do not use bushwhack on a project holding anything you would
not hand to that provider.

**You approve what changes.** Reads are free; every write, edit, move, delete and app
command waits for your yes, in the browser or in a terminal. `--yolo` answers yes to all of them without
asking: use it only on a project you can lose.

**Early software.** Tools, formats and commands may change between versions. bushwhack is
provided "as is", without warranty of any kind — see [LICENSE](./LICENSE). How it keeps
the chat in its lane is in [SECURITY.md](./SECURITY.md) and [ARCHITECTURE.md](./ARCHITECTURE.md).
