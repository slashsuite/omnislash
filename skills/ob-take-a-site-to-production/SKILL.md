---
name: ob-take-a-site-to-production
description: Take a new website live on its real domain, or audit one already live. Covers the contract, getting paid and the owner's written sign-off, who owns each account, billing with spend limits and alerts so a bot flood cannot run up a bill, DNS, email, TLS and security headers, caching, opening the site to search engines (Search Console, Bing, redirects from the old site), monitoring, legal pages, the cut-over and the handover. Use before any site goes to production, replaces a client's live site, or leaves a bot-blocked prototype.
---

# Take a site to production

A site is **live** when the real domain serves the build you meant, search engines can index it,
mail to and from the domain works, a flood of traffic cannot turn into a bill, someone hears when it
breaks, the client owns every account it runs on, and the contractor running the work has a
signed agreement, the owner's written sign-off and their money. This skill gets there and ends on a
**go-live report**: one table, a row per check, each `pass`, `fail`, `n/a` or `needs-contractor` with the evidence.

Written for our stack (TanStack Start on Cloudflare Workers with static assets, Bun). On another
platform keep every check and find that platform's way of doing it. Prices and limits below were
checked on 2026-11-17; re-read the linked page before quoting one to a client.

**Who decides.** Anything that costs money, changes a plan, or touches an account the client owns
needs the contractor's yes (and the owner's, through the contractor) before you do it: list it in the report as
`needs-contractor` and carry on with the rest. On a zone that already carries a site or mail, every DNS
change is additive (`ob-deploy-a-worker-on-a-subdomain-of-a-live-zone`), with one exception: at the
cut-over (step 10) the apex and `www` web records of the site being replaced are removed so the Worker
can take them, using step 3's saved record list to roll back. Never `wrangler login`: credentials
come from `ob secret get` (`ob-infra`).

Step 0 decides what may start (its gates). Steps 1 to 9 set everything up before the cut-over; each
ends on what can be checked then, and what only the live domain can show is checked in step 10. Once step 3 has fixed the canonical host, steps
4 to 9 are independent: hand them to subagents in parallel, each returning its rows of the report.

## 0. The contract and the deposit

The contractor signs, sends, is paid and confirms payment; you do none of the four. Your part is to check
what exists, list what is missing as `needs-contractor` rows, and hold the steps that need it. If there
is no agreement, say so; draft only the scope and price schedule that go into the contractor's template, never
the agreement itself. Step 0's rows are `n/a` only for our own site. Work for a client, an audit of
their live site included, goes through step 0 unless the contractor says in the thread that it is unpaid;
record that they did.

- **A signed agreement**, from the contractor's lawyer-reviewed template. Check it covers:
  - **Scope:** the pages and features, what is out of scope, and how many rounds of changes.
  - **Price and payment:** a deposit before work starts, and the balance due before the cut-over
    (step 10).
  - **Ownership:** the code, design and content made for the client pass to them on full payment,
    and not before. The contractor keeps what they brought (a UI kit such as UISlash, their scripts and skills), and the
    client gets a perpetual, non-exclusive licence to use those parts for this site. The contractor may show
    the site in their portfolio.
  - **Liability:** capped at the fees paid, except for intent or gross negligence, and nothing for
    outages or changes at third parties (Cloudflare, Shopify, the registrar) or for the client's own
    content. A client the Consumer Protection Act covers (a person, or a business under its turnover
    and asset threshold) gets the clause set out conspicuously and initialled (CPA section 49), or it
    does not bind.
  - **Personal data:** the contractor is the client's operator under POPIA, so the agreement binds them to
    keep the section 19 security measures, to process only on the client's authority and in
    confidence (section 20), and to tell the client of any suspected breach at once (section 21).
  - **Sign-off:** what counts as accepted (a written yes), and what happens if nobody answers.
  - **After launch:** support, fixes and renewals are out of scope unless a retainer says otherwise,
    and the rate if they are asked for.
- **Running costs in the client's name.** Paid accounts (Cloudflare plan, domain, mail sender,
  error tracker) are billed to the client's card. Anything the contractor has to front (a `.co.za` bought
  before the client has an account) is listed in the report and goes on their invoice.
- The agreement and invoices are kept outside the site's repo: their location is a note on the
  client's ob project.

**Gates.** No signed agreement: only work inside the repo on the preview runs (steps 5 to 9 as far
as a local build shows them). Signed but no deposit: still nothing on an account the client owns.
Both: steps 1 to 9 run. Step 10 has its own gate.

**Done when** the contractor confirms the agreement is signed and the deposit is paid, or each is a
`needs-contractor` row and the gates above hold.

## 1. Accounts and ownership

The client owns the accounts; we are members until the handover (step 10). For each of Cloudflare, the registrar, Search Console,
Bing Webmaster Tools, the mail provider, Shopify (if any) and the error tracker, record: whose
account, our role on it, where its 2FA and recovery codes are (an `ob secret` name, never the value).

- A client site lives in the client's Cloudflare account with ours added as a member, not in ours. A
  site on our account (a subdomain of a zone of ours) says so in the report.
- Domain: auto-renew on, registrar lock on, the registrant contact is the client, and the expiry date
  is in the report. Cloudflare Registrar does not sell `.co.za`, so a South African domain stays at a
  local registrar.

**Done when** every account has an owner, our role and a 2FA note, and the domain's expiry is known.

## 2. Billing, limits and alerts

The aim is that no traffic, however large, can produce a bill nobody expected.

- **Plan.** Know the plan and what it includes. Workers Paid (checked 2026-11-17): $5 a month,
  10M requests and 30M CPU ms included, then $0.30 per million requests and $0.02 per million CPU ms.
  KV writes ($5 per million past 1M) and D1 rows written ($1 per million) are the usual traps. On the
  Free plan the Worker fails past 100,000 requests a day rather than billing, and asset requests then
  get a 429 too, so a busy Free site goes down instead of costing money: say which the client prefers.
- **Spend limit.** Billing > Spend Management (or `cf billing spend-policies create`, action
  `usage_block`) with a dollar threshold and a `notification_email`, which the dashboard leaves empty.
  It covers Workers and Durable Objects only (not KV, R2 or D1), is account-wide, blocks minutes late,
  and is not an exact cap. Past it SSR pages fail with error 1103 while static assets still serve.
  https://developers.cloudflare.com/workers/platform/spend-management/
- **Budget alert.** Billing > Billable Usage > Create budget alert, to an address someone reads.
- **CPU limit (Paid only).** `limits.cpu_ms` in `wrangler.jsonc`, set near what SSR needs (measure it
  in Workers observability; 50 is a reasonable start for a content site), so a slow path cannot burn
  CPU. On Free it is `n/a`: the plan's own 10 ms cap applies and the setting is refused.
- **Assets stay free.** Static assets are free when the Worker does not run for them. `run_worker_first:
  true` (a bot guard that runs the Worker first needs it) makes every asset request a billed Worker request; prefer a
  list of paths, or record the cost.
- **Flood control.** A rate limiting rule on the zone (the Free plan has one: path and per-IP, 10 s);
  rate limit bindings and Turnstile on any form or write a stranger can reach. Whether WAF-blocked
  requests count as Worker requests is not stated by Cloudflare: after the first block, check Workers
  analytics and record what you saw.
- Every other paid service (mail sending, error tracking, a font) is in the report with its plan and
  monthly cost.

**Done when** the plan, the spend limit (or why there is none), the budget alert, `cpu_ms` and the
rate limit rule are each in the report with where they are set.

## 3. Domain and DNS

Read the zone first (`ob-deploy-a-worker-on-a-subdomain-of-a-live-zone`, step 2) and save the record
list in the report, so a later change can be compared with it.

- The apex is a Worker custom domain (`routes: [{ pattern, custom_domain: true }]`, Cloudflare owns
  the record and certificate). `workers_dev: false` and `preview_urls: false`, so no second host can
  be found or indexed.
- `www` 301s to the apex (or the reverse; one canonical host): a proxied placeholder record
  (`AAAA www 100::`) plus a Redirect Rule `*://www.*` to `https://${2}`, query string kept, so
  `http://www` also lands in one hop. Every other host and `http://` reach the canonical one in a
  single 301.
- DNSSEC on in Cloudflare and the DS record at the registrar. Moving nameservers from an old
  provider: turn its DNSSEC off first, or the domain fails to resolve.
- CAA is optional. If you add one, allow Google Trust Services, Let's Encrypt, SSL.com and Sectigo:
  custom domains use Advanced certificates, which Cloudflare's hidden CAA records do not cover.
- Replacing a live site: lower the old records' TTL a week before the cut-over.

**Done when** the record list is saved in the report, the canonical host is decided, and the
redirect rule, DNSSEC and TTLs are set (verified live in step 10).

## 4. Email

Every domain gets the rows that apply, added together, and every domain gets DMARC:

| If the domain | Add |
| --- | --- |
| Receives mail (forwarded to a mailbox) | Cloudflare Email Routing (free): it adds its MX, SPF and DKIM; verify each destination; at least the owner's address and `privacy@` |
| Sends mail (contact form, orders) | The sender's DKIM, and its include in the one SPF record (two SPF records are a permerror, so merge, never add a second). Sender: Cloudflare Email Sending (`send_email` binding, Workers Paid, 3,000 a month included; mail only to verified addresses is free on any plan, enough for a form that mails the owner), or Resend |
| Receives nothing | `MX 0 .` (and no other MX) |
| Sends nothing | `v=spf1 -all` |
| Always | DMARC: `p=reject` when nothing sends; otherwise `p=none; rua=mailto:<reader>` for a week once SPF and DKIM pass, then `quarantine` |

A domain already carrying mail (Google Workspace, a host's mailboxes) keeps its records; only add, and
merge into its existing SPF record.

**Done when** the records are in the zone and match the table: one SPF record, a DMARC record, and a
DKIM record for each sender (mail is tested live in step 10).

## 5. TLS, security headers and errors

- SSL/TLS: Always Use HTTPS on, minimum TLS 1.2, Automatic HTTPS Rewrites on.
- HSTS: start at `max-age=2592000` (one month) without preload; raise it to a year once the site has
  run clean. HSTS cannot be undone quickly, so never preload a domain whose subdomains are not all
  on HTTPS.
- Headers: `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, a `Content-Security-Policy`
  (`frame-ancestors 'self'` at least) and a `Permissions-Policy` turning off what the site does not
  use. The Worker sets them on what it renders; static assets are served without the Worker, so they
  get theirs from a `_headers` file in the build output (`/*` for these headers).
- An unknown path returns a real 404 page with status 404, never the home page with a 200 (a soft 404
  that Search Console files as a duplicate). A server error shows a plain 500 page with no stack trace.

**Done when** on a local production build (`vite preview` or `wrangler dev`) a page, an asset and a
missing path each carry the headers and the right status, and the zone's TLS settings are set.

## 6. Caching

- Hashed build assets (`/assets/*`): `public, max-age=31536000, immutable`. The Workers assets
  default is `max-age=0, must-revalidate`, which makes every reload re-ask for every file. Set it in
  `_headers`, with a `! Cache-Control` line first so only one value is sent; a site whose bot guard runs the Worker
  first sets it in its Worker entry instead.
- HTML: `public, max-age=0, must-revalidate` for pages that change with a deploy; `private, no-store`
  on anything personal (cart, account). A response that sets a cookie is never shared-cached.
- Cache only what is the same for everyone, keyed by the deploy, and
  purge with a narrow Cache Purge token, never the deploy token. Workers Cache (2026) caches SSR
  responses too, but turning it on makes asset requests billable: a decision for step 2.

**Done when** the local production build serves an asset, a page and a personal page with the
`Cache-Control` above.

## 7. Search engines

A prototype is closed to crawlers in three ways, and each one alone keeps the site out of Google.
Remove all three: the bot guard (one that 403s Googlebot), the `X-Robots-Tag:
noindex` header and robots meta, and `Disallow: /` in `robots.txt`. Keep them on every other host
(staging, previews), for example behind a `SITE_INDEXABLE` setting.

- The build passes `ob-ui-testing`'s MARKETING-SITES.md checks: a title, meta description,
  self-canonical on the canonical host and OG tags on every page, `robots.txt` naming the sitemap,
  `sitemap.xml` listing every page and nothing else, a favicon and an OG image.
- **Replacing a live site:** list every URL the old site has (its sitemap, the snapshot, Search
  Console's pages report) and 301 each one that moves to its new page, from one redirect table. Keep
  paths where you can (Shopify's `/products/<handle>` and `/collections/<handle>`). Redirects stay at
  least a year. A Shopify store going headless moves checkout to a subdomain
  (`checkout.<domain>` CNAME to `shops.myshopify.com`) and installs the redirect theme on the old
  online store; update its Google and Meta product feeds.
- **Search Console:** a Domain property verified by a TXT record on the apex (keep the record for
  ever). Change of Address only when the domain itself changes.
- **Bing Webmaster Tools:** import from Search Console once that is verified. Turn on Cloudflare's
  IndexNow (Crawler Hints) for Bing and the others.
- **Analytics:** Cloudflare Web Analytics (no cookies, no personal data) unless the client needs
  more; anything that sets cookies or tracks for ads waits for step 9's consent decision.

**Done when** the production build serves no noindex header or meta and a `robots.txt` that allows
crawling, the redirect table covers every old URL, and Search Console is verified.

## 8. Monitoring and backups

- Uptime: an external check on the home page and one SSR page every few minutes, alerting the owner
  and the contractor. Let it past Bot Fight Mode, which cannot be skipped by rules (keep Bot Fight Mode off
  or use a monitor Cloudflare verifies).
- Errors: Workers observability on (`observability.enabled: true`); Sentry or similar for the browser,
  with a scrub for cookies and personal data.
- `<meta name="build-commit" content="<sha>">` on every page, and the smoke run checks it against the
  commit deployed (MARKETING-SITES.md), so a deploy that never happened is caught.
- Backups: the repo is in the client's (or our private) GitHub; any D1, KV or R2 data has an export
  before every migration and a restore that has been tried once.

**Done when** the uptime check, the error tracker and the build-commit meta are configured, and any
data store has had one export restored.

## 9. Legal (South Africa)

- A privacy notice that covers POPIA section 18: who the business is, what is collected and why, who
  receives it (Cloudflare, Shopify, the mail sender, analytics), that it leaves South Africa, and the
  person's rights including complaining to the Information Regulator. Linked from the footer.
- The owner is the Information Officer by law and must register on the Regulator's eServices portal;
  tell the contractor, it is the owner's step.
- A shop sells online, so ECTA section 43 applies: the legal name and legal status, physical address,
  phone number, registration number, an address for service of legal documents, and terms, returns
  and delivery policies, with the section 44 cooling-off right in the returns policy. Take every
  detail from the owner; never invent a registration number or address.
- Cookies: essential only, or cookieless analytics. Ad or marketing pixels need opt-in consent;
  newsletters need opt-in and an unsubscribe in every mail.

**Done when** the pages are in the build and linked, and each statement in the privacy notice matches
what the site actually does.

## 10. Cut over and verify

Start only with all three, confirmed by the contractor in this thread: the agreement is signed (step 0), the
owner has signed off in writing on the site as it stands on its staging host (the bot-blocked
prototype on a staging subdomain such as `<code>.<your-domain>`, or another host closed to crawlers) and on the setup rows of the
go-live report (an email reply counts; the contractor sends the request), and the balance is paid. If the contractor
says to go ahead without one of them, record that in the report. For our own site the gate is
the contractor's go.

1. Run the repo's gate on the commit to ship.
2. Cut over, in this order: remove only the old apex and `www` web records (step 3's list is the
   rollback), deploy with the repo's script so the custom domain route creates the apex record (a
   deploy while the old record exists fails with `hostname already has a DNS record`), then add the
   `www` placeholder.
3. Prove the deploy is real (`ob-deploy-a-worker-on-a-subdomain-of-a-live-zone`, step 4): the record
   exists, `curl` gets 200, and the T3 browser renders the live URL at 1440px and 390px in both
   colour schemes with a clean console.
4. From outside, with `curl -sI` and `dig`: `http://` and `www` on every host reach the canonical
   `https://` URL in one 301; a page, an asset and a missing path carry step 5's headers and status;
   an asset carries step 6's `Cache-Control`; DNSSEC validates (`dig +dnssec`).
5. Run the smoke checks against the live URL (MARKETING-SITES.md), the build-commit check included,
   and every old URL in step 7's list answers 200 or one 301 to a 200.
6. Mail: a test message to each receiving address arrives, and a form submission arrives with SPF,
   DKIM and DMARC all `pass` in its headers.
7. Search Console: submit the sitemap, then URL Inspection, Test live URL and Request indexing on the
   home page.
8. Monitoring: point the uptime check at a wrong path once and see the alert; throw a test error and
   see it in the tracker.
9. Click through the main journey on a real phone if the contractor has one to hand. A shop runs one order
   through checkout in the payment provider's test mode; a real charge and refund is `needs-contractor`.
10. Keep the old host until its traffic reaches zero, then retire it.
11. Handover is the contractor's (`needs-contractor`): list for them the repo, each account where we hold more
    than the support agreement needs, and each account still on ours with its `ob secret` names.
    They transfer the repo and pass any codes by a channel they pick; you change no role and send
    nothing.

**Done when** every item above passes on the live URL, not on a preview, URL Inspection says the
home page can be indexed, and the handover list is with the contractor.

## 11. The go-live report

The results are data first, so a client portal (not built yet) can show them later: write them to `go-live.json`
in the client's private notes (`~/dev/<client>-notes/`, never the site's repo, since contract and
payment rows are in it), one object per check:

```json
{ "id": "billing.spend-limit", "step": 2, "area": "Billing", "check": "spend limit on Workers",
  "result": "pass", "evidence": "$20, usage_block, mails owner@", "by": "agent", "at": "2026-11-17T14:00:00Z" }
```

- `result` is one of `pass`, `fail`, `n/a`, `needs-contractor`. Anything the owner must do reaches
  them through the contractor, so it is `needs-contractor`.
- `by` is who confirmed the result: `agent` for a check you ran, `owner` for the sign-off (the only
  row the owner can confirm), `contractor` for the contract, deposit and balance rows (only they can
  confirm payment) and for anything else they did themselves (the handover, a real charge). You write
  `owner` and `contractor` rows only from the contractor's word in the thread, and say so in `evidence`.
- Keep the file current as you go (it is how a later run resumes; note its path on the client's ob
  project, beside the agreement's); re-running a check replaces its row.

Then `docs/go-live.md` in the site's repo holds the technical rows only (no contract, payment or
sign-off rows), and your last message to the contractor is the whole table:

| Area | Check | Result | Evidence |
| --- | --- | --- | --- |
| Contract | owner's sign-off | pass | email from the owner, 2026-11-20 |
| Billing | spend limit on Workers | pass | $20, usage_block, mails owner@ |
| DNS | www 301 to apex | pass | `curl -sI https://www...` |
| Search | home page indexable | needs-contractor | owner must add us to Search Console |

Every check in steps 0 to 10 is a row. Below the table: the monthly running cost and who pays it,
every account with its owner, the domain expiry date, and the `needs-contractor` rows as a numbered
list. Ask them those one at a time (`ob-ask-one-by-one`).

**Done when** `go-live.json` has a result on every row, `docs/go-live.md` is committed, and the table
is your last message.
