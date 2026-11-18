# acme-app
React app. `bun run test` runs Vitest (happy-dom, Testing Library). `bun run test:e2e` runs Playwright against the production build and is part of the CI gate. `bun run smoke` runs `smoke/*.smoke.test.ts` after a deploy, against the deployed site (`SMOKE_BASE_URL`), with the smoke account.
