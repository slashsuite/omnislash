---
name: ob-new-project
description: Scaffold a new project on the OmniSlash standard stack (Bun, TanStack Start, Cloudflare, Drizzle, Tailwind, Oxlint, Vitest, Playwright), create its private GitHub repo once the human confirms, register it with `ob project add`, and hand off to wire-ob-architect-into-a-repo. Use when asked to start a new project, new repo or new app through the architect.
---

# New project on the standard stack

[`STANDARD-STACK.md`](STANDARD-STACK.md) (`<your OmniSlash checkout>/skills/ob-new-project/STANDARD-STACK.md`)
is the standard. [`template/`](template/) holds the files that implement it. Read the standard
first. This skill is the procedure and does not restate it.

A **new app inside OmniSlash** (`apps/<name>`) follows steps 1 to 3 on its ticket's `wt` branch. It also
needs a `moon.yml` with `typecheck` / `lint` / `test` / `build` tasks, its id in `.moon/workspace.yml`
(so the moon land gate sees it), and `tags: ['ob-ts']` when it imports `apps/cli`, `platform/*` or
`domains/*` (so a change anywhere in the repo busts its cache; `.moon/tasks/ob-ts.yml`). It skips steps 4 to 6.

## 1. Pin the name and shape

Ask for anything not given: the name (kebab-case), the `ob` kind (`side` / `home` / `personal` /
`business`), and whether it is a web app or a CLI/library (see the standard). Check that
`~/dev/<name>` is free and that the name is not in `ob project list`.

Done when: the name, kind and shape are settled and the path is free.

## 2. Scaffold locally

```bash
cd ~/dev
CREATE_CLOUDFLARE_TELEMETRY_DISABLED=1 bun create cloudflare@latest <name> \
  --framework=tanstack-start --platform=workers --no-deploy --no-git --no-open < /dev/null
cd <name>
```

C3 delegates to the TanStack CLI, which brings Tailwind, React devtools and a demo app. For a
CLI/library, use `bun init` instead and take only the non-web files below.

Then:

1. **Drop the demo.** `rm -rf src/components src/routes/about.tsx`, then
   `bun remove @tanstack/react-devtools @tanstack/react-router-devtools @tanstack/devtools-vite @tailwindcss/typography`.
   Its code fails the anti-slop lint, and the template replaces what remains.
2. **Copy the template.** `cp -r <your OmniSlash checkout>/skills/ob-new-project/template/. .`, then
   replace `__NAME__` in `src/routes/index.tsx`. Merge `package.scripts.json` into `package.json`'s
   `scripts` (replacing them), delete `package.scripts.json`, and drop the `pnpm` block. The copy brings `bunfig.toml` (isolated linker
   and global store, see STANDARD-STACK.md); run `rm -rf node_modules && bun install` so the layout matches it.
3. **Add the tools.**
   `bun add drizzle-orm` and
   `bun add -d typescript@latest drizzle-kit oxlint oxlint-tsgolint oxfmt vitest @playwright/test`,
   then `bunx playwright install chromium`. TypeScript must be 7+ for type-aware lint.
4. **Generate the first migration:** `bun run db:generate` writes `drizzle/0000_*.sql` for the
   `accounts` table, including its `is_smoke` column. The D1 binding (with
   `"migrations_dir": "drizzle"`) is added by the first deploy ticket, not here.
5. **Payments.** Keep `src/payments/` only if the project takes money. Otherwise delete it; the
   first payments ticket copies it back from the template, because every charge must go through it.
6. **Format once:** `bun run format`.
7. **`.gitignore`:** append `test-results/` and `playwright-report/` (C3 already covers
   `.wrangler`, `.dev.vars*`, `dist`).
8. **`AGENTS.md`:** write it to `ob-wire-ob-architect-into-a-repo` step 1's sections. The gate section
   links the standard's gate. The tracker is `ob`, and landing is no-PR via `ob-land`. Also create
   `repos/<name>/AGENTS.md` in your main repo with the "Browser test runs take the `cpu:browser` lease"
   section (copy it from an existing `repos/<project>/AGENTS.md`), naming this repo's `test:e2e` and any Storybook
   command, so the first local browser run already waits for the machine-wide slot.
9. `git init -b main`, `git add -A`, first commit.

Done when the standard's full gate passes from the repo (typecheck, lint, format:check, test,
build, test:e2e (run as `ob lease run cpu:browser -- bun run test:e2e`), plus `bunx wrangler deploy --dry-run --outdir /tmp/<name>-dry` for a web app), and
`git status` is clean.

## 3. Show the dry run

Show the human the tree, the scripts, the gate output and the exact commands for steps 4 and 5.
Nothing so far has touched GitHub or Cloudflare.

Done when: the human has seen it.

## 4. Create the private GitHub repo, only on an explicit yes

This publishes to an external service, so it waits for the human to confirm the name.

**Pick the owner first: your GitHub account or organisation.** A new product of a suite you keep in
its own organisation is created in that organisation. Every other new project is created under your
own account. Existing repos stay where they are until a move is planned. Set it once:

```bash
OWNER=<your-organisation>   # a new product of the suite
OWNER=<your-account>        # anything else
gh repo create "$OWNER/<name>" --private --source . --remote origin --push
```

Always `--private`. If they decline, stop with a local-only repo and say so. Step 5 still works
without `--remote`.

Done when: `gh repo view "$OWNER/<name>" --json visibility` reads `PRIVATE`.

## 5. Register with ob

```bash
ob project add <name> --kind <kind> --remote "git@github.com:$OWNER/<name>.git"
```

Done when: `ob project list` shows the row.

## 6. Hand off

Load `ob-wire-ob-architect-into-a-repo` and follow it from step 2 (`AGENTS.md` exists). Its standard
check should file nothing for a repo built here. The first deploy is its own ticket, using
`deploy-a-worker-on-a-subdomain-of-a-live-zone`. That ticket adds the D1 binding, applies the
migrations, seeds the smoke accounts and stores their credentials (see "Deploy order" in the
standard).

## Dry run, end to end

Steps 1 to 3 have been run for real (a web app, in a scratch directory,
twice; the second run followed step 2 word for word). The whole gate passed: typecheck, type-aware
lint, format:check, the tests (smoke isolation, payment guard), build, test:e2e and the wrangler
dry run. `test:smoke` also passed against a locally served build. Steps 4 and 5 were not run because
they call GitHub. The only external calls in steps 1 to 3 are the package installs.
