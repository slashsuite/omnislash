# ob-dashboard

The OB dashboard (OB-2199): the tracker's own app, apart from the personal dashboard, which is not part of this repo.
Bare `ob web` builds and serves it (on `:5050` unless `--port` says otherwise); CT 143 serves it on `:5070`. It has its own Home Screen app
(manifest `id` `/ob`).

- `serve.ts` hosts the built app: the realtime socket (`/api/realtime`), the stamped `sw.js`, the static
  client and SSR. No consent pages and no WhatsApp routes (personal, not ob). The ob API is its own
  server (`createObApi` in `apps/cli/src/api/server.ts`) and is not mounted here. The request handling is `serve-handler.ts`, which `test/serve.test.ts` drives.
- Errors go to the same Sentry project as the personal dashboard (`omnislash-web`); the unit's
  `OMNISLASH_SENTRY_ENVIRONMENT` tells them apart.
- Shared parts (realtime hook, PWA register, item drawer, guarded writes) come from
  `platform/dashboard-kit` by path. Nothing under `src/` opens the store itself: `serve.ts` opens it and
  hands the getter over with `provideStore` (`provided-store.ts`), and a server function
  reads it with `providedStore()`; a write wraps a kit write. A test provides a fixture store the same way.
  `vite dev` has no `serve.ts`, so a page that reads the store (`/alerts`) throws there; run the built app.
- Pages: `/` (To review and the ranked focus), `/queue`, `/alerts` (with ack and snooze), `/tokens` (the
  credential inventory with Check now and paste, and the WhatsApp pairing panel), `/models` (model routes and
  review readers, which replaced the old Reviewers page), `/timeline` and `/machine`. Every ob page lives here
  (OS-214); the personal dashboard keeps none. `components/ObFrame.tsx` is the header: the nav, the alert bell
  (live count from the realtime snapshot) and the live badge.

Commands (moon): `bunx moon run ob-dashboard:build`, `ob-dashboard:test` (builds first; `bun test` over `test/`
and `src/`, then vitest for the happy-dom route tests in `src/route-tests/*.vitest.tsx`), `ob-dashboard:typecheck`.
Dev: `PORT=$(ob ports next -q --holder <you>) bunx moon run ob-dashboard:dev` (binds `--host`, on that port only).
Built: `ob web --port <n>` (ob-dashboard is what bare `ob web` serves).
