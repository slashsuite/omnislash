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

## Choosing a builder's model for one dispatch

`ob spinoff <ticket>` picks the builder's model from the `--complexity` score and the active models
profile. Two flags override that for one dispatch, without switching the profile:

- `--model <[provider:]model>` runs this row on the named model (a bare id on the T3 project's own
  provider, `claudeAgent:claude-haiku-5-5` on a named one). The row still records its complexity and tier.
  An urgent ticket keeps the named model, although its score is still raised to 7. A `--model` dispatch
  runs no model trial.
- `--effort low|medium|high|xhigh|max` runs it at that reasoning effort. Opus above its default effort
  also needs `--opus-high '<the owner's ask>'`.

An unknown model, a provider T3 does not advertise or reports unusable, or an effort the model does not
take is refused by name before any row is written. `ob spinoff show <row>` prints the model and effort
the launch ran on. See [Command reference](docs/commands.md) for the full rules.

## Quick start

```sh
bun install
bun apps/cli/src/index.ts --help
```

See [Install & develop](docs/guide.md#install--develop) for the full setup.
