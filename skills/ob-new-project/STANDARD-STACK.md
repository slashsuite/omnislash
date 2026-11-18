# The standard stack for new projects

Every **new** project the architect creates uses this standard: a new app inside OmniSlash, or a new
repo created through the OmniSlash architect. One standard stack for every new project. Existing
OmniSlash apps are not migrated to it.

This file is the single source of truth. `ob-new-project`, `ob-architect` and
`ob-wire-ob-architect-into-a-repo` link here. The files that implement it live next to it in
[`template/`](template/), and `ob-new-project` copies them into the new repo.

## Tools

| Tool | Role | Concretely |
|---|---|---|
| **Bun** | package manager + script runner | `bun.lock` committed, no other lockfile; `bun run <script>`, `bunx` |
| **moon** | monorepo task runner (only when the repo has several projects; never Nx) | `@moonrepo/cli` pinned to an exact version in `devDependencies` and `trustedDependencies`; `.moon/workspace.yml` lists the projects, one `moon.yml` per project; no toolchain declared, so tasks run on `system` and moon never installs Bun, and `pipeline.installDependencies: false` so it never runs `bun install`; `bunx moon run <project>:<task>`. OmniSlash is the reference |
| **TypeScript 7** | types | strict tsconfig (below); `tsc --noEmit` |
| **TanStack Start** | app framework | React, file routes under `src/routes/` |
| **Cloudflare** | hosting | Workers via `@cloudflare/vite-plugin` + `wrangler.jsonc`; D1 for data, R2 for files |
| **Drizzle** | data layer | `drizzle-orm` on D1, `drizzle-kit generate` writes `drizzle/` migrations |
| **Tailwind** | styling | v4 via `@tailwindcss/vite` |
| **Oxlint** + **Oxfmt** | lint + format | VoidZero's Rust linter and formatter (the engines inside Vite+). `oxlint-tsgolint` for type-aware rules |
| **Vitest** | integration + unit tests | `vitest.config.ts`, separate from `vite.config.ts` |
| **Playwright** | e2e + smoke tests | `e2e/` (local build) and `smoke/` (deployed app) |

**`bunfig.toml` sets the isolated linker and the global virtual store, and every project ships it.**
Every worktree runs `bun install`, so install cost is paid per worktree. With `linker = "isolated"`
and `globalStore = true`, packages are extracted once into Bun's cache and symlinked into
`node_modules/.bun/`, which took a warm worktree install from 480-680 ms to 53 ms.

**Required, and checked: repo setup must make sure this is enabled.** A repo whose `bunfig.toml` lacks `linker = "isolated"` and `globalStore = true` builds a full `node_modules` tree in every worktree; with over a hundred worktrees on one desktop that metadata churn helped make its SSD the bottleneck (it was found off on two marketing sites). Creating a project copies the template's `bunfig.toml`; wiring an existing repo checks it; an architect's Step 0 standard-stack check files a missing one as a ticket at once; `ob project check` will fail on it.

- **The linker alone is not the win.** On Bun 1.4.2 `linker = "isolated"` still hardlinks every file.
  The shared store is the separate `globalStore = true` key (or `BUN_INSTALL_GLOBAL_STORE=1`).
  `bun.lock`'s `configVersion = 1` already defaults a workspace to the isolated linker.
- **Undeclared imports fail.** A package that imports a dependency it never declared cannot find it,
  because its real path is in the cache and the hidden `node_modules/.bun/node_modules` fallback is
  out of reach. Declare the dependency in the package that needs it. For a third-party package you
  cannot edit, put it in `trustedDependencies`. Bun keeps trusted packages and their dependency closure
  project-local (a lifecycle script must not mutate the shared copy), so the import resolves again.
  OmniSlash needed this for `bun-types` (imports `undici-types` undeclared; drop the entry once
  bun-types declares it) and `storybook` (loads `@storybook/react-vite` by name).
  `globalStore = false` is the project-wide fallback.
- **Declare what each package uses.** A root `devDependency` still resolves from every workspace
  package by walking up the tree, but that is accidental. Put `vitest`, `@types/bun` and the like in
  the package that runs them, and pin a range, not `latest`.
- **A Dockerfile must copy `bunfig.toml`** next to the manifests before `bun install`, or it silently
  installs with the default layout.
- **Not yet proven on the scaffolded stack.** OmniSlash proves it for its own packages. The first
  project scaffolded from this template should run the gate and report any package that needs the
  fixes above.

**Versions:** latest stable of each at scaffold time. This file names no version numbers. They
would be stale within a week.

**Oxlint and Oxfmt run as standalone packages, not through the Vite+ `vp` CLI.** Vite+ 1.0 bundles
the same engines behind `vp lint` / `vp fmt` / `vp test`, but adopting it means swapping the whole
toolchain. That is a separate call. Oxfmt is still 0.x. Type-aware Oxlint needs TypeScript 7+.

**Any other tool** (an auth library, a UI kit, a state manager): ask the owner before adding it.

## A repo that is not a web app

A CLI or a library takes Bun, TypeScript, Oxlint/Oxfmt, Vitest and Playwright (it drives the real
binary in a process the way a web app's e2e drives a browser). It takes the strict tsconfig and the
anti-slop config unchanged. It gets TanStack Start, Cloudflare, Tailwind and Drizzle the day it
grows a UI or a database. Its scripts keep the same names and drop the ones it has no use for.

## Strict by default

- **tsconfig:** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitOverride`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`,
  `noUnusedLocals`, `noUnusedParameters`.
- **Lint:** every rule set to `error`, never `warn`. Type-aware rules are on. The gate runs
  `oxlint --type-aware --deny-warnings`, so a warning fails it.

## Anti-slop lint

One shared config ships in every repo: [`template/.oxlintrc.json`](template/.oxlintrc.json), plus
[`template/scripts/check-slop.ts`](template/scripts/check-slop.ts) for the rules Oxlint has no
rule for. Both run in `bun run lint`.

| Slop | Enforced by |
|---|---|
| explicit `any` | `typescript/no-explicit-any` |
| non-null assertion `!` | `typescript/no-non-null-assertion` (tests exempt) |
| floating or misused promises | `typescript/no-floating-promises`, `typescript/no-misused-promises` (type-aware) |
| empty catch | `no-empty` with `allowEmptyCatch: false` |
| `console` | `no-console`; the one allowlisted logger file is `src/lib/log.ts` |
| unused vars and imports | `no-unused-vars` + tsc `noUnusedLocals` / `noUnusedParameters` |
| `as` casts outside tests | `typescript/consistent-type-assertions` `assertionStyle: never` (tests exempt) |
| `@ts-ignore` | `typescript/ban-ts-comment`; `@ts-expect-error` only with a description |
| sprawl | `complexity` 10, `max-depth` 3, `max-params` 4, `max-lines` 300, `max-lines-per-function` 80 |
| nested ternaries | `no-nested-ternary` |
| TODO/FIXME without a ticket ref | `check-slop.ts` (`TODO(#123)` passes) |
| commented-out code | `check-slop.ts` (heuristic: a `//` line that starts with a statement keyword and ends in `;` `{` `}` `)`) |
| **unused exports** | **not machine-checked.** Oxlint has no rule for it, and knip would be another tool. ob-skeptical-review asks |
| **swallowed errors** (a catch holding only a comment) | **not machine-checked.** ob-skeptical-review asks |

## Tests: four layers, each with one job

Keep the suite focused. A project has dozens of tests, not thousands.

| Layer | Runner | Job |
|---|---|---|
| **Smoke** | Playwright, `bun run test:smoke` | After deploy, against production (`SMOKE_BASE_URL`), as smoke accounts only. Fast. |
| **E2E** | Playwright, `bun run test:e2e` | The happy paths, against a local production build. No edge cases. |
| **Integration** | Vitest, `bun run test` | Components and modules working together: route + data layer, query + schema. |
| **Unit** | Vitest, `bun run test` | Only logic that the layers above do not already cover. |

**A test that duplicates a higher layer's coverage is cut.** A unit test for a function an
integration test already drives on the same path is bloat. So is an e2e for an edge case. Vitest
tests run with no network and no live database; the template's `src/db/test-db.ts` gives them the
real migrations on in-memory `node:sqlite` (Node 22.13+).

How the Playwright and DOM tests are written (selectors, waits, data, the config shape, CI) is the
`ob-ui-testing` skill.

## Smoke-test isolation

Production smoke tests are safe to run over and over because of these rules, not because they
only read:

1. **Dedicated smoke accounts.** Smoke runs sign in as fixed smoke users/tenant, never a real
   user's account. Seed them idempotently (`template/src/db/smoke-accounts.ts`).
2. **Every smoke record is synthetic and excluded.** Every table a smoke run can write carries
   `is_smoke` (`template/src/db/synthetic.ts`). Every query that feeds reporting, analytics,
   admin dashboards, metrics, billing/usage counts, search, public listings or anything another
   user can see filters with `real()`. This is in the data layer from day one.
3. **Idempotent.** Use the fixed fixtures or clean up what the run creates. Repeated runs never
   accumulate rows.
4. **No real outbound side effects.** No email, SMS, push, webhook or payment to a real recipient.
   Use provider test modes or a suppressed smoke recipient.
5. **Credentials in the secret store** (`ob secret` / CI secrets), never in the repo.
6. **A test proves the exclusion.** A smoke run leaves the dashboard and report numbers unchanged
   (`template/src/db/report.test.ts`). Each new report query joins that test.

## Smoke tests never make real payments

This is enforced in code, not by convention:

- Every charge, payout and refund goes through `guardedPayment`
  (`template/src/payments/guard.ts`). It checks the smoke flag first and refuses a live-mode call
  for a smoke account. The mode is read from the key the call will use, never passed in, and it
  fails closed: any key that is not a known test key counts as live.
- Smoke checkout uses provider test/sandbox keys only. The smoke runner's environment never holds
  live keys.
- A test proves it: a smoke account with live keys configured is refused, with no provider call
  (`template/src/payments/guard.test.ts`).
- A path that needs a real charge is not a smoke test. It stays an e2e in test mode.

## Scripts

Every repo uses the same names, so a brief, a gate and a land read the same everywhere. The exact
commands are in [`template/package.scripts.json`](template/package.scripts.json):
`dev` · `build` · `preview` · `typecheck` · `lint` · `format` · `format:check` · `test` ·
`test:e2e` · `test:smoke` · `db:generate` · `deploy` · `cf-typegen`.

**The gate**, run from a fresh worktree: `bun install`, `bun run typecheck`, `bun run lint`,
`bun run format:check`, `bun run test`, `bun run build`, `ob lease run cpu:browser -- bun run test:e2e`
(locally a browser run always takes the machine-wide `cpu:browser` lease). Add
`bunx wrangler deploy --dry-run --outdir <tmp>` when the change touches the Worker build,
dependencies or `wrangler.jsonc`, because an SSR-asset problem can pass `vite build` and fail only
at deploy. `bun run test:smoke` runs after each deploy.

**Deploy order, once a D1 binding exists:** apply `drizzle/` to the remote database
(`wrangler d1 migrations apply <db> --remote`, with `"migrations_dir": "drizzle"` on the binding)
and seed the smoke accounts, then `wrangler deploy`. Code must never go live ahead of its columns.

## Deviations

A repo off this standard is not fixed by whoever notices. The architect (or the wiring session) files
each deviation as its own ticket on that repo's `ob` project, and it is built like any other ticket.
