# ob-dashboard

The OB dashboard (OB-2199): the tracker's own app, apart from the personal dashboard, which is not part of this repo.
It is served on `:5070`; it has its own Home Screen app
(manifest `id` `/ob`).

- `serve.ts` hosts the built app: the realtime socket (`/api/realtime`), the stamped `sw.js`, the static
  client and SSR. No consent pages, no ob API, no WhatsApp routes; those stay on the personal
  dashboard. The request handling is `serve-handler.ts`, which `test/serve.test.ts` drives.
- Errors go to the same Sentry project as the personal dashboard (`omnislash-web`); the unit's
  `OMNISLASH_SENTRY_ENVIRONMENT` tells them apart.
- Shared parts (realtime hook, PWA register, item drawer, guarded writes) come from
  `platform/dashboard-kit` by path. Nothing under `src/` opens the store itself: `serve.ts` opens it and
  hands the getter over with `provideStore` (`provided-store.ts`), and a server function
  reads it with `providedStore()`; a write wraps a kit write. A test provides a fixture store the same way.
  `vite dev` has no `serve.ts`, so a page that reads the store (`/alerts`) throws there; run the built app.
- Pages: `/` (placeholder), `/alerts` (OB-2207, moved from the personal dashboard), with ack and snooze, and
  `/tokens` (OB-2208, moved from the personal dashboard): the credential inventory with Check now and paste,
  and the WhatsApp pairing panel. `components/ObFrame.tsx` is the header: the name, a Tokens link, the alert
  bell (live count from the realtime snapshot) and the live badge. OB-2210 adds the nav.

Commands (moon): `bunx moon run ob-dashboard:build`, `ob-dashboard:test` (builds first; `bun test` over `test/`
and `src/`, then vitest for the happy-dom route tests in `src/route-tests/*.vitest.tsx`), `ob-dashboard:typecheck`.
Dev: `PORT=$(ob ports next -q --holder <you>) bunx moon run ob-dashboard:dev` (binds `--host`, on that port only).
Built: `ob web --app ob-dashboard --port <n> --no-sidecar-port`.
