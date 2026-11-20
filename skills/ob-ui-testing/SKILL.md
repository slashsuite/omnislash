---
name: ob-ui-testing
description: How we write, configure and fix UI tests in every repo (Playwright e2e, Storybook interaction specs, DOM tests under happy-dom or jsdom), and what belongs in each layer. Use when writing, changing or deleting an e2e or UI test, testing a marketing or docs site, setting up a playwright.config, fixing a slow or flaky browser test, or reviewing a diff that touches one.
---

# UI testing: how we test in a browser

These rules hold in every repo. The layer policy itself (four layers, a test that
duplicates a higher layer is cut) is [`ob-new-project/STANDARD-STACK.md`](../ob-new-project/STANDARD-STACK.md)'s
"Tests: four layers"; this skill applies it to UI, adds the visual layer, and says how UI tests are
written and run. A repo's `AGENTS.md` (`ob project rules <project>`) names its commands and may add
rules; it never loosens these. They govern committed tests; a throwaway probe that checks one change by
hand (`ob-verify-an-auth-gated-page-without-oauth`) is not a test and follows its own skill.

A UI test is **a user's eyes and hands with a stopwatch taken away**: it finds things the way a user
does, waits on what the user would wait on, and starts from a world it built itself. It proves
**behaviour**: something the user does and what comes of it. How a page looks is PixelSlash's job,
and a list of what is on a page is no test at all.

## What goes in each layer

A behaviour is proved once, at the lowest layer that can see it.

| Layer | Proves | UI examples | Runs against |
|---|---|---|---|
| **Unit** | Logic with branches that are easy to get wrong | a price formatter, a filter reducer, URL parsing, a date range | one module, no DOM |
| **Integration** | One component or route keeps its contract with its data | a form validates and saves through the real handler to a temp store; a component's role, name, aria states, keyboard and the props it refuses; a static site's built HTML (meta, canonical, sitemap) | Testing Library in happy-dom or jsdom, Storybook interaction specs in a real browser, or the built `dist/` |
| **E2E** | The happy path of a user goal works from the UI, its API calls answering | create a project and see it listed; search and open a result | Playwright on a local production build; the app's API real or mocked, third parties stubbed |
| **Smoke** | The shipped build starts and does its one job | the deployed site serves `/` and signs a smoke account in | the deployed build, smoke accounts only (STANDARD-STACK) |
| **Visual** | It looks right at rest | every route or story, in each theme, desktop and phone, in each state a story or URL can hold still | PixelSlash |

A check of a local build on local data is integration, whatever its folder is called; smoke is the
deployed build only.

Marketing and docs sites have their own checklist: [`MARKETING-SITES.md`](MARKETING-SITES.md).

## Integration or e2e?

**An e2e answers one question: does the happy path work?** From the UI, a user does the thing the
feature is for, the API calls it makes answer, and the user sees the result. The API is the app's real
one running locally, or a mocked API at the network boundary; either way the UI is driven for real and
the calls really go out. One e2e per happy path of each user goal, plus the one page loop that opens
every page (MARKETING-SITES.md has its checks; in an app, every route that renders on a fresh store, an
empty state included),
and nothing else.

Everything else is **integration** or **unit**, split by where the edge case lives:

- **An edge in the logic is unit:** every boundary of a rule (64 characters against 65, an empty
  string, "Acme" against "acme", a range across midnight), all of them, in a table.
- **An edge in how the screen reacts is integration:** each kind of reaction once (an invalid value
  shows its message and nothing saves, the empty list, the pending state, a 500, a role with no
  Create button), not each boundary again through the rendered form.

Ask: *if this broke, what is the cheapest test that would go red?* That is the layer it belongs at.

**No journey needed:** on a site, links, anchors, redirects and the sitemap are checked on the built
output (MARKETING-SITES.md; on a server-rendered site the ones that read a page are `request` checks
against the preview server, the e2e suite's one other file, and the redirect table stays in Vitest). In an app, links are
typed router links the typecheck proves (TanStack Router's `<Link to>`), and redirects live in one
table a test reads. Routing, the back button, focus
restoration and scroll are the framework's job. At most one e2e per app exercises the back
button, and only when the app does something of its own with history.

### The same feature, split

"Create a project":

| Integration (Vitest + Testing Library, or a Storybook spec) | E2E (Playwright) |
|---|---|
| an invalid name shows its message and nothing saves (one test: the rule's boundaries are the unit table) | signed in, create a project from the dashboard: the create call answers, its page opens, and it is in the list |
| a duplicate name shows the server's error | |
| the button is disabled while the save is pending | |
| the list's empty state | |
| a viewer (not an owner) sees no Create button | |
| the server rejecting the save (500) shows a retry message | |

Six integration tests and one e2e test, beside one unit table for the name rule's boundaries (length,
allowed characters, a case-insensitive duplicate). An app with a dozen screens has roughly one e2e per user goal,
about 10 to 20: the happy paths you would roll a deploy back for.

### Writing a unit test

A unit test is for pure logic: input in, output out, no DOM, network, store or framework. Write one
when the logic has branches that are easy to get wrong and slow or awkward to reach through a screen:
formatting money, dates and relative times; parsing and validation rules; reducers and state machines;
sorting, filtering and permission rules; a diff, score or layout calculation. Many cases, each in
milliseconds, often as a `test.each` table.

- **Not for:** a component's markup or classes, code that only passes data along, or a branch an
  integration test already drives through the real screen.
- **A function that needs mocks of the app's own code is not a unit:** test it at integration, or pull
  the logic out into a pure function and unit-test that.
- **A fake of what the app does not own** (a browser API, a third-party client) handed in as an
  argument goes by the test's point. It is unit when the fake only feeds our logic (a fake `Storage`
  under a serialiser) and integration when the test proves the exchange with that outside thing (a
  service worker against fake `caches` and `fetch`, an R2 or Anthropic client against a fake `fetch`).

### Writing an integration test

- **Render through one helper** that wraps the real providers (router, query client, theme), so a test
  renders a route or component the way the app does. One helper per repo, never one per test file.
- **Use the real data layer:** route loaders and server handlers run against a fresh temp store (the
  template's `test-db.ts`, a temp SQLite or local D1), seeded per test by a factory. Mock only what the
  app does not own: the network to third parties, the clock, device APIs. A test that mocks the app's
  own API client is testing the mock.
- **One behaviour per test**, named for that behaviour ("a duplicate name shows the server's error").
- **Act like a user:** `userEvent.type`, `userEvent.click`; assert with `findByRole` and
  `toBeDisabled()`; wait with `findBy*` or `waitFor`, never a `setTimeout` settle. Rules 1, 2, 3, 5
  and 7 apply.
- **Fast:** a DOM test (happy-dom, jsdom) is well under a second, in the repo's `test` task, so it runs
  on every save; a slow one is setting up too much, or it is really an e2e test. Storybook interaction
  specs run in their own browser task, under the lease.

### Writing an e2e test

- **One happy path per test**, written as the goal ("an owner creates a project and finds it in the
  list"), its stages in `test.step`.
- **Against the production build** (`build` then `preview`, or the worker), on a fresh migrated store,
  every third party stubbed (rules 3 and 4). The app's own API runs for real locally, or is mocked at
  the network with `page.route` or a stub server when the backend is separate (a C# service, another
  repo). A mocked API answers with the same shapes as the real one, from the same fixtures or types.
- **The calls are part of the proof:** wait on the response that matters, started before the action
  that sends it (`const saved = page.waitForResponse(isCreate); await save.click(); await saved`, or
  the row it returns appearing), and check what the user sees came from it. A `waitForResponse`
  started after the click misses a fast response and times out now and then.
- **Arrange through the back door, act through the front door.** Create the data the journey needs
  (the account, an existing project) with an API call or fixture; drive only the steps the journey is
  about through the UI. A journey that clicks through three setup screens before its real step is slow
  and fails for the wrong reason.
- **Assert the outcome the user would see** at the end of each step (rule 5), not every element on the
  way.

### Adding a visual check

A visual check is a shot, not a spec: one entry in the repo's PixelSlash config (a route or a story),
shot in each theme on desktop and phone and compared with the baseline on `main`.

- **Every route and story has a shot.** A change that adds a route, a story or a state a user can land
  on (empty, filled, an error page, long content) adds it to the capture list in the same change.
- **A state is shot when a story holds it still.** A look that only shows after the user does something
  (a hover highlight, a slider part way, a focused row, an open menu) gets a shot when a Storybook
  story renders that state from its args or data alone, the same on every run. A state that needs a
  mouse move, a drag, a scroll position or a timer to reach is not shot, and no test drives the move,
  drag or scroll to check how it looks, where something sits or whether it is still in view (calling
  that an outcome does not change it; a sticky rail gets no test). An integration test proves the
  state behind it where there is one (the slider's value, `aria-current` on the rail link,
  `aria-expanded`), and that the state paints right is left unproved. A reliable test that proves less
  beats a flaky one.
- **The shot's world is built, like a test's** (rule 3): seeded data through the config's `setup`, the
  clock and animations frozen by `stabilise`, nothing loaded from outside the origin. A shot that
  differs between two runs of the same code is a flake: fix what moves, or mask it with a reason.
- **A changed shot is read.** The change's `Visual:` result says how many shots changed and why each
  was expected (the repo's recipe in its `AGENTS.md`); an unexpected change is fixed, not approved.

## The rules

### 1. Find elements the way a user does

Locate by role and accessible name first: `getByRole('button', { name: 'Save' })`, then `getByLabel`,
then `getByText` for static copy. A failing role query is an accessibility bug: fix the markup (a label,
a name, the right element), then the test. `data-testid` is the fallback for something with no
accessible name a user could use (a canvas, a chart body, a map), with a one-line comment saying why.
Scope inside a region with a chained locator (`page.getByRole('dialog').getByRole('button', ...)`).
CSS classes, element ids, tag names, XPath and DOM walks (`..`, `ancestor::`, `nth-child`) are never
selectors. The one exception is the app's ready marker, `html[data-hydrated]` (rule 2). This governs
finding what a user sees and acts on; a check that parses built HTML (meta tags, `href`, `id`) reads
it as data.

### 2. Wait on a state, never on a clock

Every wait is on a state: a web-first assertion on something the user can see
(`await expect(locator).toBeVisible()`, `toHaveText`, `toHaveURL`, `toBeEnabled`), the app's ready
marker (below), or the response a step depends on (`page.waitForResponse`). Fixed sleeps
(`waitForTimeout`, `setTimeout`, `Bun.sleep`) and `waitForLoadState('networkidle')` are not waits.

- **Ready means hydrated, and the app says so.** An app's root component sets a marker once React has
  hydrated, and tests open pages through one helper that waits on it (a static page with no client app
  is ready at `load`, which `page.goto` already waits for, so there it is a plain `goto`):

  ```tsx
  // root component
  useEffect(() => { document.documentElement.dataset.hydrated = "true" }, [])
  ```
  ```ts
  // e2e/ready.ts
  export async function open(page: Page, path: string) {
    await page.goto(path)
    await expect(page.locator("html[data-hydrated]")).toBeAttached()
  }
  ```
  Probing React internals (`__reactProps$`) or idling the network to guess at hydration goes away.
- **Time is an input.** Freeze or move the browser clock with `page.clock` (`install`, `setFixedTime`,
  `runFor`). When the server orders by a timestamp with one-second resolution, fix the ordering in the
  app (an id tiebreak) or set the timestamp in the fixture; a test that waits for a second to tick is
  waiting on the clock.
- **Pending and loading states are values a test sets** (a held promise, a stub that has not answered,
  a story arg), not a race the test hopes to catch.
- **Timeouts stay at the defaults.** A raised `timeout` or `expect.timeout` carries a comment with the
  measured reason (a cold production build in `webServer`, a real child process). A raised timeout is
  never a flake fix.

### 3. Every test owns its world

- Each e2e run, and each integration test that reads or writes a store, starts from a **fresh,
  migrated store** (a new local D1 or temp SQLite in `webServer` or `globalSetup`). Never a
  hand-seeded developer database or a gitignored `.wrangler` copy. A component test with no store has
  nothing to reset.
- Each test **creates the data it reads** through a fixture that calls the app's API or seeds the store,
  with unique names (`org-${test.info().testId}`), so tests pass in any order and alone. A fake service
  with state keys that state by test (a header or path carrying the test id), so parallel tests never
  see each other's; a global reset (`POST /__reset` in `beforeEach`) is safe only under `workers: 1`.
- `test.describe.serial` and tests that restore rows for the next test are a sign of shared state: give
  each test its own rows instead.
- Sign-in is a `setup` project that saves `storageState` (or seeds a session row, see
  `ob-verify-an-auth-gated-page-without-oauth`), never a test-mode auth bypass in the app. A journey
  test starts signed in and never drives the sign-in form, not even against a stubbed provider; the
  setup project is the one place sign-in runs (against a stubbed provider it is also the sign-in
  flow's test).

### 4. The network ends at localhost

Every external service is a local stub in `webServer` or a `page.route` handler: OAuth providers,
Turnstile (a stub of its script and its verify call: its test keys still load Cloudflare's script),
map tiles, Sentry, model APIs, payment providers, GitHub. A test that needs the internet is a smoke
test against a deployed build, not an e2e. The one exception is STANDARD-STACK's real-charge path: an
e2e that needs a real test-mode charge calls the provider's sandbox with test keys, with a comment
pointing at that rule. Test servers bind `127.0.0.1` on a
port named in one place (`e2e/ports.ts`); `reuseExistingServer: false`, so a test never talks to a
stale dev server.

### 5. Assert what the user sees

The outcome of a step is checked on the page: the row appears, the toast reads the right thing, the URL
changed. Reading the store directly is for what has no UI by design (a synthetic flag, a smoke-account
exclusion, an outbound message that was suppressed), named in a comment. One `if` in a test is two
tests: a test has no conditionals and no `try/catch` around assertions.

### 6. One journey per test

A test is one user goal (the page loop's one test per page aside), with `test.step('...')` naming
its stages so the trace and report read like the journey. A test that covers two goals is two tests; a
long one usually has setup that belongs in a fixture (arrange through the back door). `toPass` retry
wrappers around a click hide a real bug (a dropped click is a hydration or disabled-state bug): fix it.

### 7. Behaviour in tests, look in PixelSlash

Tests (Vitest and Playwright alike) assert behaviour and content. Everything about how it looks goes to
PixelSlash, whose shots cover every route or story in each theme:

- **No assertions on classes or styles:** `toHaveClass` on a styling token, `toHaveCSS`,
  `getComputedStyle`, `classList`, `className` string matches, a Tailwind token in an `expect`, a test
  that a class was removed, exact-markup `toBe('<span class=...')`. A token rename breaks them and a
  real regression slips past them.
- **A state is its aria attribute:** selected, pressed, expanded, checked, current, disabled and invalid
  are asserted with `toHaveAttribute('aria-pressed', 'true')`, `toBeDisabled()`, `toBeChecked()`. A
  state the markup cannot express is an accessibility bug to fix first. The theme is no exception: a
  test checks the theme control's state (`aria-pressed`, the selected option) and that it survives a
  reload; whether the page looks dark is PixelSlash's, which shoots each theme.
- **A design-system rule is a lint or a type, not a string search.** "No colour on the link variant",
  "no raw colours", "positive never borrows another tone" belong in the repo's lint (UISlash's
  `slopRules`, the ui-review layer 1, and for apps on `@hackcove/ui-react` the `@hackcove/oxlint-ui`
  package) or in the component's props (UISlash's `noStyling.test.tsx`:
  components refuse `className` and `style`, one structural test instead of hundreds).
- **No layout geometry:** widths, font sizes, spacing rhythm, column counts, alignment measured in
  pixels. That is look. The one measurement that stays is **no sideways scroll** at the phone width
  (`scrollWidth - clientWidth` is 0): content off the side of a phone cannot be reached, so it is an
  outcome, not a look.
- **No presence inventories.** A test that lists elements and checks each is visible or counted (logo,
  nav links, hero, three cards, footer) with no action and no outcome is deleted: a page that renders
  is one line in the page loop, and what is on it is the visual shot. A presence check stays only when it
  guards a decision (a theme picker that must not come back), as one assertion naming that decision.
- **A look that moves is not tested as a look:** hover, drag, scroll position, animation, reduced
  motion. A story that holds the state still gets a shot; otherwise an integration test proves the
  state and nothing asserts the paint (Adding a visual check).
- **No pixel compares in specs:** no `toHaveScreenshot`, no `page.screenshot` diffs.
- **A "make it look X" ticket ends with an approved PixelSlash shot**, not a new permanent spec. Its
  `## Done when` names the shot to approve.

A repo's visual check recipe is in its `AGENTS.md`. A PixelSlash failure is filed urgent to the
PixelSlash architect, not worked around (`ob-spinoff`, step 3).

### 8. One config shape

Every app or site `playwright.config.ts` starts from this and states any change with a reason (a CLI
or library that drives its own binary follows STANDARD-STACK instead). A change that adds or touches an
e2e test brings an off-shape config to this shape in the same change: a test
written to these rules is only trustworthy under `retries: 0` and a fresh server, and a flake that
`retries: 0` then exposes is reported under the flake rule (rule 9), not hidden again.

```ts
export default defineConfig({
  testDir: "e2e",
  forbidOnly: !!process.env.CI,
  retries: 0, // a flaky test is a bug to fix, never retried
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["iPhone 15"], browserName: "chromium" } }, // phone viewport, Chromium
  ],
  webServer: { command: "...", url: `http://127.0.0.1:${PORT}`, reuseExistingServer: false },
})
```

- **Browsers: Chromium only.** Apps, sites and the
  design system's Storybook run Chromium and nothing else: no Firefox, no WebKit, in Storybook, visual, e2e or
  CI runs. The phone project keeps its viewport and touch on Chromium:
  `{ name: "phone", use: { ...devices["iPhone 15"], browserName: "chromium" } }`. A config that has another
  browser drops it the next time it is touched, and a PR that adds one goes back.
- **Parallelism:** `fullyParallel: true` when rule 3 holds; `workers: 1` only when one shared store
  forces it (one D1 file gives `SQLITE_BUSY`), with that comment.
- **Per-project scope** is `testIgnore` / `testMatch` on the project, not `test.skip(isMobile)` in every
  test. A skip that stays is `test.skip(condition, 'why, and the ticket')`; a bare `test.skip`,
  `test.fixme` or `test.only`, or their `test.describe.` forms, does not land.
- **A test that fails every time on one project is a finding, not noise:** the phone user probably
  cannot do that thing either. Scoping it off that project is allowed only with the ticket filed as a
  bug against the feature on that device, and the handoff says so in those words.
- **CI uploads `playwright-report/` and the traces** as an artifact when a run fails.

### 9. Where it runs

- **CI, every PR, in the gate.** A repo's e2e suite (every project, the phone one included) runs on
  every pull request and a red e2e blocks the merge. In a moon repo that means the e2e task is part of
  the CI gate's command; a gate of only `:typecheck :test` does not run it, so wiring it in is part of
  adding the suite. A suite that exists and does not run in CI is a ticket. ("CI is out of scope" in
  the lease rule means CI takes no lease, not that e2e stays out of CI.)
- **Locally, under the lease:** `ob lease run cpu:browser -- <command>` (your agent rules). One leased run finishes inside 10 minutes (a flake fix runs in an isolated box with dedicated CPUs and memory instead, with no lease and no cap): `ob lease run` stops it at the cap with exit 124, so split a longer suite or a repeat proof into several leased runs.
- **A test that fails and then passes** on the same code is a flake: reported and ticketed, never rerun
  past (`ob-spinoff`, step 3).

## Done when

Before you hand off a change that adds or touches a browser test, all of these hold:

- [ ] oxlint is green on the files you changed, with the repo's config extending the shared
  `@hackcove/oxlint-testing`. It enforces what a linter can see of rules 1, 2, 7 and 8:
  selector strings and raw locators (the ready marker allowed), sleeps and `networkidle`, class, style
  and screenshot assertions, bare or ticketless skips, `.only`, and the config values above. A line it
  flags that is a genuine exception (a `setTimeout` inside a stub server) carries an
  `oxlint-disable-next-line <rule> -- why` comment. Old violations in a file you touched are the repo's
  `ui-testing` ticket, not yours, except the Playwright config, which you bring to shape (rule 8). In a repo that does not extend it yet, the lines you add meet those
  rules by eye, and wiring it in is that repo's `ui-testing` ticket.
- [ ] Every new test does something and checks what came of it; none only lists what is on a page.
- [ ] Every new locator for something a user sees or acts on is a role, label or text query, a test id
  with its reason, or the ready marker.
- [ ] What lint cannot see, checked by eye: each test owns its data and store (rule 3), nothing it
  needs leaves localhost (rule 4), and each test sits in the layer "Integration or e2e?" puts it in.
- [ ] A route, story or still state this change adds is in the repo's PixelSlash capture list, and the
  change carries its `Visual:` result, where the repo has a recipe.
- [ ] Each new test passes alone (Playwright `--grep '<title>'`, Vitest `-t '<name>'`) and in a full
  run, on every project.
- [ ] The browser suites (Playwright, Storybook) ran green under the lease and the DOM tests in the
  repo's `test` task. A suite this change adds runs in the repo's CI gate in this same change; an
  existing suite that does not yet is named with its ticket (rule 9).

## Bringing an existing suite up to this

A repo whose suite breaks these rules is fixed by a ticket on that repo's architect, not in passing inside
an unrelated change: an inventory first (each spec against rules 1 to 9, with counts), then the fixes,
with no behaviour that a cut test proved left unproved. Deleting a look or presence test is a fix, not a
loss of coverage, once PixelSlash shoots that route or story. An app nothing shoots yet gets its
PixelSlash recipe first, as its own ticket, and its look tests stay until the shots exist. Where a
repo's own testing doc disagrees with this skill (layers by folder, a behaviour proved again at a
higher layer on purpose), the skill wins and the doc is changed in that ticket. Per-repo tickets
for this carry the tag `ui-testing`.
