# acme-app
TanStack Start app on Cloudflare Workers with D1. `bun run test` runs Vitest (happy-dom), `bun run test:e2e` runs Playwright against the production build. The API is the app's own server functions; a local D1 is created by `bun run db:migrate:local`. Sign-in is Google OAuth.

## Production
Deployed to https://app.acme.dev by `bun run deploy`. Accounts live in D1 table `user`; projects in `project`. Billing reports and the admin user count read those tables.
