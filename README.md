# OmniSlash

OmniSlash is a command-line work tracker and agent coordinator. The `ob` command keeps tickets, projects
and the agents that work on them in one place, and it ships with an API server and a web dashboard.
It is built with Bun.

## Status

Alpha. Anything may change or break, and there is no compatibility promise yet.

## Requirements

- Bun 1.4.5, the version pinned in `.bun-version`.

## Getting started

```sh
bun install
bun apps/cli/src/index.ts --help
```

## Development

Run the type checks and the tests with moon:

```sh
bunx moon run --concurrency 3 :typecheck :test
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md): how the CLI, the API, the dashboard and the packages fit together.
- The `ob` CLI: the [guide](apps/cli/docs/guide.md), the [command reference](apps/cli/docs/commands.md)
  and the [changelog](apps/cli/CHANGELOG.md).
- [Glossary](GLOSSARY.md): the words the code, the docs and the tickets use.
- [Contributing](CONTRIBUTING.md): setup, the gate and how a change lands.
- [Features](FEATURES.md): the full feature list.
- The apps and packages, each with its own README:
  - [`apps/cli`](apps/cli/README.md): the `ob` CLI and its API server.
  - [`apps/ob-dashboard`](apps/ob-dashboard/README.md): the web dashboard.
  - [`platform/cli-core`](platform/cli-core/README.md), [`platform/cli-coord`](platform/cli-coord/README.md),
    [`platform/cli-db`](platform/cli-db/README.md), [`platform/cli-sources`](platform/cli-sources/README.md),
    [`platform/cli-whatsapp`](platform/cli-whatsapp/README.md),
    [`platform/dashboard-kit`](platform/dashboard-kit/README.md) and
    [`platform/state-machine`](platform/state-machine/README.md).
- To give another repo an `ob` architect, run `ob project wire <project>` in its checkout (see the
  [`ob-wire-ob-architect-into-a-repo`](skills/ob-wire-ob-architect-into-a-repo/SKILL.md) skill).

## Licence

OmniSlash is source-available under the Elastic License 2.0 (see [`LICENSE`](LICENSE)). It is not an
open source licence.

## Security

See [`SECURITY.md`](SECURITY.md) for how to report a vulnerability.
