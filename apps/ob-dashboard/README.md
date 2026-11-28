# ob-dashboard

The OB dashboard: the tracker's own web app. Bare `ob web` builds and serves it (on `:5050` unless `--port`
says otherwise). It has its own Home Screen app (manifest `id` `/ob`). See
[docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md#the-dashboard) for how it fits with the rest.

- `serve.ts` hosts the built app: the realtime socket (`/api/realtime`), the stamped `sw.js`, the static
  client and SSR. No consent pages and no WhatsApp routes. The ob API is its own
  handler (`createObApi` in `apps/cli/src/api/server.ts`) and is not mounted here. The request handling is `serve-handler.ts`, which `test/serve.test.ts` drives.
- Errors go to Sentry when its DSN is in the `ob secret` store (`apps/cli/src/sentry/report.ts`).
  `OMNISLASH_SENTRY_ENVIRONMENT` names the environment.
- Shared parts (realtime hook, PWA register, item drawer, guarded writes) come from
  `platform/dashboard-kit` by path. Nothing under `src/` opens the store itself: `serve.ts` opens it and
  hands the getter over with `provideStore` (`provided-store.ts`), and a server function
  reads it with `providedStore()`; a write wraps a kit write. A test provides a fixture store the same way.
  `vite dev` has no `serve.ts`, so a page that reads the store (`/alerts`) throws there; run the built app.
- Pages: `/` (To review and the ranked focus), `/queue`, `/alerts` (with ack and snooze), `/tokens` (the
  credential inventory with Check now and paste, and the WhatsApp pairing panel), `/models` (model routes and
  review readers), `/timeline`, `/machine` (the role state machine as a graph) and `/overview` (the same machine
  as persona swimlanes). `components/ObFrame.tsx` is the header: the nav, the alert bell
  (live count from the realtime snapshot) and the live badge.

Commands (moon): `bunx moon run ob-dashboard:build`, `ob-dashboard:test` (builds first; `bun test` over `test/`
and `src/`, then vitest for the happy-dom route tests in `src/route-tests/*.vitest.tsx`), `ob-dashboard:typecheck`.
Dev: `PORT=$(ob ports next -q --holder <you>) bunx moon run ob-dashboard:dev` (binds `--host`, on that port only).
Built: `ob web --port <n>` (ob-dashboard is what bare `ob web` serves).
