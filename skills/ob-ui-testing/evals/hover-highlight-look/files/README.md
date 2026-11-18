# acme-app
React app. `bun run test` runs Vitest (happy-dom, Testing Library). `bun run test:e2e` runs Playwright against the production build. Storybook stories live beside components (`*.stories.tsx`). `bun run visual` has PixelSlash shoot every story in light and dark and compare it with main; a change reports its result as a `Visual:` line.
