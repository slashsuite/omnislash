# `ob` — the OmniSlash CLI

`ob` is a personal command-center for everything you're working on: a single, prioritized
worklist across side projects, home, admin, and learning, backed by Postgres by default, with a
local SQLite file as the opt-in, fully scriptable (`--json` / `-q`), and grown over time into four cooperating layers.

Core tracking is zero-network. On top of it sit read-only **source connectors** (Gmail /
Calendar / WhatsApp), an agent **coordination** layer (leases, the agent registry, spinoffs), and
an **automation** layer (a daemon that runs on launchd on macOS and on a systemd user timer on Linux, a live dashboard, and off-machine backup).

## Documentation

- [Guide](docs/guide.md): how `ob` fits together (the layers, the daemon jobs), the global conventions
  (database location, the client/server split, the API), common workflows, configuration, and how to
  install, develop and test it.
- [Command reference](docs/commands.md): every command and its flags, and the ob API surface.
- [Changelog](CHANGELOG.md): the migrations and decisions behind today's behaviour.

`ob --help` gives the compact command overview; `ob <command> [subcommand] --help` and `ob help env`
provide focused reference pages.

## Quick start

```sh
bun install
bun apps/cli/src/index.ts --help
```

See [Install & develop](docs/guide.md#install--develop) for the full setup.
