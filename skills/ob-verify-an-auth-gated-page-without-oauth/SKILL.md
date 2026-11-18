---
name: ob-verify-an-auth-gated-page-without-oauth
description: "Reach and verify a signed-in page (owner tools, admin screens, any /manage/ID) in a local TanStack Start + Cloudflare D1 app when Google OAuth cannot be completed, then prove the whole write loop with a real browser. Use when an acceptance criterion says an owner or admin can do something from a gated page, when the page redirects to a provider you cannot sign in to, or when a form revision \"does not work\" but you have not yet watched a real submit go out."
---

# Verify an auth-gated page without OAuth

A gated page cannot be verified through the front door: the redirect leaves the
machine. The trap is to conclude from a DOM poke that the page works, or from a
blank form that it is broken. Both happened in one real case: the first
attempt to submit the owner form filled the wrong textarea and produced no
request, no error and no row, which looks exactly like a broken server function
and was actually a bad selector.

## 0. Say what you cannot make real

You can make the session and the data real. You cannot make the provider real.
Write down which half you faked in the final report; the reader has to know.

## 1. Find the database the running server actually reads

For a TanStack Start app on the Cloudflare Vite plugin, that is the miniflare D1
under the **worktree**:

```
<worktree>/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite
```

It is gitignored, so a fresh `wt` worktree has none. A fresh empty DB renders
the app's real empty state (in one shop directory, 92 shops became zero pins). Copy it
from a sibling worktree rather than re-seeding:

```bash
cp -r /path/to/sibling-worktree/.wrangler .
```

Confirm the row count before trusting anything you see:

```bash
node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("<path>.sqlite");
console.log(d.prepare("select count(*) c from store").get())'
```

## 2. Read the real column list from the migrations

Never assume. Query `PRAGMA table_info`, or read the migrations in order, because
the shapes that bite are the ones a different ticket added. Real examples from
a shop directory app:

- `session` is `(id, user_id, expires_at)`: there is **no** `created_at`, and
  an insert that supplies one fails at runtime, not at review time.
- `shop_owner` requires `granted_at` (NOT NULL).

```bash
node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("<path>.sqlite");
for (const t of ["session","shop_owner","user"]) console.log(t, d.prepare(`pragma table_info(${t})`).all().map(c=>c.name))'
```

## 3. Seed the session, then the ownership edge

Three rows, in the DB's own file, with the real columns:

1. a `user` row (a working email, role `shop_owner` for an owner page),
2. a `session` row whose `id` **is** the cookie value the app reads,
3. the ownership row that makes the gate pass (`shop_owner`, with its
   `granted_at`).

```bash
# session cookie value == session.id; expires_at in the future
node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("<path>.sqlite");
const iso=new Date().toISOString();
d.prepare("INSERT OR REPLACE INTO user (id,email,name,picture,role,google_sub,created_at) VALUES (?,?,?,?,?,?,?)")
 .run("local-owner","owner@local.test","Local Owner",null,"shop_owner","local-sub-1",iso);
d.prepare("INSERT OR REPLACE INTO session (id,user_id,expires_at) VALUES (?,?,?)")
 .run("local-session-token","local-owner",new Date(Date.now()+7*864e5).toISOString());
d.prepare("INSERT OR REPLACE INTO shop_owner (user_id,shop_id,granted_at) VALUES (?,?,?)")
 .run("local-owner","<shop-id>",iso)'
```

If a check compares against an admin email env var, note that a local
`.dev.vars` without `ADMIN_EMAIL` set makes every admin check deny, so the admin
path is not testable locally until you set it.

## 4. Run your own server on your own port

A dev server on the default port may belong to a **sibling worktree**. Check
before believing:

```bash
ss -ltnp | grep -E ':3000|:4173'
npx vite dev --port 3100 --strictPort
```

## 5. Drive it with a throwaway probe that does a real submit

Use Playwright with the session as a cookie, not a DOM poke. Because the page
reads the cookie on the server, set it as context state:

```ts
test.use({ storageState: { cookies: [{ name: "app_session", value: "local-session-token",
  domain: "localhost", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" }],
  origins: [] } });
```

Put the probe in a file you will delete, and give it its own config so it does
not start the repo's webServer:

```bash
ob lease run cpu:browser -- npx playwright test --config=playwright.probe.config.ts   # one browser run at a time; testMatch: tmp-probe.spec.ts, webServer: undefined
```

## 6. Before you believe a failure, prove the request went out

Two assertions, every time:

```ts
page.on("request", r => { if (r.url().includes("_serverFn")) calls.push(r.url()) });
// just before the click:
const state = await page.evaluate(() => { const f = [...document.querySelectorAll("form")].at(-1)!;
  return { valid: f.checkValidity(), fields: [...f.elements].map(e => ({ v: (e as HTMLInputElement).value,
    ok: (e as HTMLInputElement).checkValidity() })) } });
```

`checkValidity()` false means the browser never submitted: no request, no error,
no row. That is a test bug, not a product bug.

**The selector trap.** Two fields can share a placeholder. On one app's manage
page both textareas were placeholdered `Description`, so
`fill('textarea[placeholder="Description"]')` filled the *listing* one and left
the *event* one empty; `required` then blocked submit silently and made a working
form look broken. Prefer a label or `getByRole`; where two fields genuinely
collide, fix the placeholder in the product (it is a real clarity problem) and
then assert on the corrected one. Assert the values land before clicking.

## 7. Prove the loop, not the button

A form that says "saved" proves nothing. Assert in order:

1. the server function's own response body (watch the `_serverFn` request),
2. the row in SQLite, including the field the form was supposed to convert,
3. the public page the write is meant to change,
4. and the gate you must not have broken (e.g. an unverified shop still refused
   a create).

For a state-changing local fixture (flipping `trust_level`, approving a claim),
note the original value and put it back.

## 8. Clean up

Delete the probe spec and its config, delete the seeded rows (user, session,
ownership edge), restore any fixture field you changed, and delete
`test-results/`. Then confirm `git status --short` shows only the intended work:
a seeded session row or a probe file reaching a commit is the failure this whole
procedure exists to prevent.