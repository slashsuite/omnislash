# dashboard-kit

Shared parts for dashboard apps built on `ob`: the item drawer, the realtime hook, the service worker
and PWA parts, the client types for the realtime snapshot, a same-origin guard, and the guarded writes
a dashboard makes. It is source only. Apps import its files by relative path, and it has no build step.

`apps/ob-dashboard` uses it, and so can a dashboard app that lives outside this repo.

## Main modules

- `src/components/ItemDrawer.tsx`: the item detail drawer, with start, ready, block, close and reopen.
- `src/components/LiveBadge.tsx`: shows whether the realtime socket is connected.
- `src/components/PwaRegister.tsx`, `src/lib/registerSw.ts`: register the service worker and show an
  update notice after a deploy.
- `src/components/IosStatusBarBand.tsx`: a fixed band under the status bar of a Home Screen web app on
  iOS and iPadOS.
- `src/lib/useRealtime.ts`, `src/lib/realtimeUrl.ts`: the client side of the realtime socket, on the
  page's own origin under `/api/realtime`.
- `src/lib/types.ts`: client copies of the snapshot types from `apps/cli/src/realtime.ts`, so the
  client bundle never imports server code.
- `src/lib/localTime.ts`: time display in one fixed zone.
- `src/build-commit.ts`, `src/lib/buildCommitMeta.ts`: put the build's commit in a `<meta>` tag.
- `src/server/same-origin.ts`: rejects a POST server function called from another origin.
- `src/server/writes.ts`: the `ob` writes a dashboard makes. Each one checks the origin first.
- `src/server/item-transition.ts`, `queue.ts`, `groups.ts`, `model-routes.ts`, `reviewers.ts`,
  `config-io.ts`, `sw-version.ts`: server-side reads and writes for the pages, each taking a store so
  tests can pass a fixture.

## Dependencies

- Imports `apps/cli` (store, workflow, settings) and `platform/cli-whatsapp` (pairing), by relative
  path.
- Packages: `react`, `react-dom` and `@slashsuite/ui-react`.
- Imported by `apps/ob-dashboard`.

## Tests

```sh
bunx moon run dashboard-kit:test
```

The task runs `bun test ./test` (preloading `apps/cli/test/preload.ts`), then `vitest` for the
`test/*.vitest.tsx` component tests under happy-dom.

## Gotchas

- Server code in `src/server/` must stay out of client bundles. Keep it reachable only through each
  app's server functions.
- `src/lib/types.ts` is a hand-kept copy. When the snapshot in `apps/cli/src/realtime.ts` changes,
  update it too.
- `reviewers.ts` does not import the store, so its tests and any client bundle never load the Postgres
  driver. `config-io.ts` holds the store side.
- The service worker registers only over HTTPS or on localhost, and never under `vite dev`.
