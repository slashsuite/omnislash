# Security

## Reporting a vulnerability

Please report it privately, not in a public issue. Use GitHub's private vulnerability reporting at
https://github.com/slashsuite/omnislash/security/advisories/new, or email hello@hack-cove.com if you
cannot use GitHub. Say what you found, the version or commit, and the steps to reproduce it. A proof
of concept helps.

These are targets, not guarantees: we aim to acknowledge a report within 5 working days, and to give
a fix or a plan within 30 days. We will credit you in the advisory unless you ask us not to.

## What is in scope

- The `ob` CLI in `apps/cli`, and its API server.
- The dashboard in `apps/ob-dashboard`.
- The shared packages under `platform/`.

Examples: a token or secret written to a log or a file, one user reaching another user's data through
the API, or a crafted input that runs code.

Out of scope:

- A deployment you configured weakly.
- A dependency bug that does not affect OmniSlash. Please report it upstream.
- A finding that needs a stolen token.

## Supported versions

OmniSlash is in alpha. Only the latest `main` gets fixes.
