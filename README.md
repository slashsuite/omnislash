# OmniSlash

OmniSlash is a command-line work tracker and agent coordinator. The `ob` command keeps tickets, projects
and the agents that work on them in one place, and it ships with an API server and a web dashboard.
It is built with Bun.

## Status

Alpha. Anything may change or break, and there is no compatibility promise yet.

## Requirements

- Bun 1.4.2, the version pinned in `.bun-version`.

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

The command reference is in [`apps/cli/README.md`](apps/cli/README.md).

## Licence

OmniSlash is source-available under the Elastic License 2.0 (see [`LICENSE`](LICENSE)). It is not an
open source licence.

## Security

See [`SECURITY.md`](SECURITY.md) for how to report a vulnerability.
