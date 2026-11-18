# Testing a marketing or docs site

Part of `ob-ui-testing`; every rule there applies. A marketing site has little behaviour and a lot of
look, so most of what goes wrong is either a broken promise to a crawler or a visitor (a dead link, a
missing canonical, a 404 that serves 200) or a look regression. The first is tested; the second is
PixelSlash. A site with no tests beyond this list is correctly tested.

The pixelslash site (`apps/site`) and slashslash are the references: copy what they check, not their
geometry specs.

## The built output, no browser

A static site checks the files in `dist/` in Vitest, against a fresh build: the task that runs them
depends on `build` (moon `deps`, or `build && vitest run`), so a stale `dist/` never passes. On a
server-rendered site the checks that read a page (meta, canonical, OG, `robots.txt`, the sitemap, links
and anchors) are HTTP requests in the e2e suite (Playwright's `request` fixture against the preview
server, no page opened), because Vitest tests make no network calls (STANDARD-STACK); the rest (the
page list, the redirect table, slop, contrast) stay in Vitest:

- [ ] **The page list is one constant** (`src/content/pages.ts`) that the nav, the sitemap and the
  tests all read. A page added there is checked everywhere without a new test.
- [ ] Every page has one `<title>`, a `meta description`, a `canonical` on the site's canonical host,
  and OG title, description and image (the image exists in the build at the size the card needs).
- [ ] `robots.txt` and `sitemap.xml` exist and the sitemap lists exactly the page list.
- [ ] Every internal `href` and `#anchor` in the build resolves to a page or an id in it.
- [ ] Every entry in the one redirect table (`_redirects` or the router's) points at a page in the page
  list, and no redirect source is itself in the page list. Moving or removing a page adds its entry in
  the same change; the smoke check below proves the host serves it.
- [ ] Banned words and em and en dashes are refused by a check the site adds to `scripts/check-slop.ts`
  (the template's version checks TODOs and commented-out code only).
- [ ] Every foreground token meets WCAG AA against every background it is declared for, in each theme.
  This stays beside axe: axe sees only the pairs on the pages it renders, this covers the declared
  pairs no page shows yet.

Copy is checked only where it is a promise with a cost when wrong (a price, a licence, "no account
needed"), and then against the content constant it is rendered from, never a pasted literal. Wording
changes edit one place.

## E2E: the page loop, desktop and phone

One parameterised spec loops the page list, on the desktop and phone projects, both on Chromium (no other browser):

- [ ] Each page answers 200 and reaches the hydration marker (static Astro pages: the load event).
- [ ] No sideways scroll (`scrollWidth - clientWidth` is 0) at the phone width.
- [ ] axe finds no violations, in each theme.
- [ ] No request leaves the origin (fonts, scripts and images are served from the site). A catch-all
  `context.route('**/*')`, registered before any stub, so it runs last: requests to the origin and to
  the local stub servers (`127.0.0.1`) get `route.fallback()`, everything else is pushed to a `leaked`
  list and aborted. The test scrolls down one viewport at a time (`page.mouse.wheel(0, height)` until
  the bottom), so every lazy loader fires, then waits until each image the page renders has settled,
  hidden ones left out (`await expect.poll(() => page.evaluate(() => [...document.images].filter((i) => i.getClientRects().length > 0).every((i) => i.complete))).toBe(true)`;
  an aborted image counts as settled, and a page with no images passes at once, which is right). Only
  then does it end with `expect(leaked).toEqual([])`. Lazy content that is not an image (an embed
  loaded on scroll) gets a wait on what it shows, in that page's own test. Stubs on other hosts answer
  before it ever runs, so they need no exception, and an unstubbed path on a stubbed host is caught.

Then one test per real behaviour the site has, and only those: search finds and opens a result, a copy
button copies, the theme toggle's state persists across a reload, the phone menu opens and shows its links,
docs content shows with JavaScript off. A form (waitlist, contact) gets one submit to a stub.

## Smoke, after deploy

What only the real host can show, against the deployed site (`SMOKE_BASE_URL`). It is a named task (for
example `smoke`), the site's deploy instructions point at it, and it runs after every production deploy.
A direct-upload host serves whatever was last uploaded, so a built-output test passing in the repo proves
nothing about the live site (on one site the real 404, `robots.txt` and sitemap were merged
two days earlier, never redeployed, and Search Console still filed every one as broken).

**Every website names the commit it was built from.** Every page of every site and web app we deploy carries in its head `<meta name="build-commit" content="<full sha>">`, read at build time (`git rev-parse HEAD`, or `BUILD_COMMIT` when the build has no git), with `-dirty` added for an uncommitted tree; nothing of it renders. The first smoke check reads it: with `SMOKE_EXPECT_COMMIT` set, the home page's `build-commit` must equal it, so the run proves which commit went out. Found when a deploy believed done had not happened, and only the host's API showed the live build was four days old.

- [ ] The home page's `build-commit` meta equals `SMOKE_EXPECT_COMMIT` (run with `SMOKE_EXPECT_COMMIT=$(git rev-parse HEAD)` from the commit you deployed).
- [ ] An unknown path answers 404 with the site's 404 page. A `404.html` in `dist/` or a local preview
  does not prove it: a host with an app fallback serves `index.html` with a 200.
- [ ] Each moved page answers 301 to its new address, read from the same redirect table:
  `request.get(from, { maxRedirects: 0 })`, then the status is 301 and `location` is the table's
  target (`request.get` follows redirects by default, so without it a missing redirect passes).
- [ ] `/robots.txt` answers 200 with a `text/plain` content type, not HTML, and names the sitemap.
- [ ] `/sitemap.xml` answers 200 with an XML content type, not HTML. An app fallback serves both files
  as the home page's HTML with a 200, so a check of the status alone passes.
- [ ] Every `<loc>` in the live sitemap answers 200 with `maxRedirects: 0`, and each page's canonical
  equals its own `<loc>`.

**Host note, Cloudflare Pages.** An upload with no `404.html` at its root serves `index.html` with a 200
for every path it cannot find. That is a soft 404, and Google files each one as a duplicate of the home
page ("Alternative page with proper canonical tag").

## Reading Search Console

After a deploy that fixes a crawl problem, submit the sitemap, then press "Validate fix" on each row
that was fixed. What the rows usually mean:

- **Alternative page with proper canonical tag:** a soft-404 fallback (above) or URL variants such as
  query strings. Fix the fallback; a genuine variant is fine and is left alone.
- **Page with redirect:** expected for http, a missing trailing slash and `/index.html`. It is a problem
  only when the sitemap, a canonical or an internal link points at the redirecting form.
- **Not found (404):** open the row to see the URL. An old page with inbound links gets a redirect in the
  table; anything else is left alone.
- **Crawled, currently not indexed:** Google's call. It usually settles once the duplicates are gone and
  the sitemap is submitted.

## Visual: PixelSlash on every page

- [ ] PixelSlash shoots every page in the page list, in each theme, desktop and phone, and a change to
  the site carries its `Visual:` result like any other UI change.

This is what replaces the layout specs. Widths, rhythm, font sizes, the hero edge, column counts and
heading colour are all look: a ticket that changes them ends with an approved shot.

## Not tested

Lighthouse scores and analytics, unless the site's own ticket asks for them. Presence inventories of
the header, footer, cards or links (rule 7): the page loop and the shots already cover them.
