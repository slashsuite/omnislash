// ob 337 pass 3: `ob lease`, `ob agent` and `ob agents` SERVED FROM POSTGRES, through cli.ts's routing.
//
// pg-coord-337 proves the modules agree across the two engines. This proves the other half, which is a
// different claim: that the COMMANDS reach those modules under `OMNISLASH_STORE=postgres` without touching
// a SQLite file at all. Those are separable failures -- a command can be perfectly ported and still be
// handed a raw handle by the routing, which is the exact hole pass 2 found in `commandStore` -- so the
// list in servable.ts is only as good as an end-to-end run behind it.
//
// 456 emptied the DATA unported class: `ob person` was this file's last stand-in, and it is served.
// There is no next DATA command to refuse (do not pick one). The test below asserts the 337
// unported-store refuse is GONE for person (`POSTGRES_SERVABLE_COMMANDS` contains it; handler/routing
// coverage is api-data-456.test.ts). Pass 5 added `ob spinoff` to the list, so it is asserted here in
// the POSITIVE: it enqueues and lists entirely on Postgres, and its one sqlite-only subcommand
// (`watch`) refuses by name.
//
// `runCli` runs in-process, which is what makes this cheap: cli.ts closes the Postgres store (resetStore)
// in its own finally, so each invocation opens and closes its own connection and nothing leaks into the
// next test. The harness cluster is local over a unix socket: no network, no live database.
//
// THE ONE THING SUPPLIED DIFFERENTLY, and why. `OMNISLASH_PG_URL` cannot address this cluster: Bun's SQL
// client reaches a unix socket through its options object (`path`), not through a url -- a
// `postgres://ob@/db?host=/socket/dir` url is rejected outright, and the `?host=` spelling libpq
// understands makes Bun dial localhost over TCP instead, which the harness does not listen on. So the
// per-process store singleton is PRIMED with the harness's own connection options before each
// invocation, exactly as ob 325's own tests hand them to `openStore`. Everything downstream of that is
// the real thing: the servable-list decision, the stand-in handle in place of a file, `commandStore`
// handing the singleton to the handler, and the absence of any SQLite file at the end.
import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { runCli, spawnBudget } from "../../../apps/cli/test/helpers.ts";
import { getStore, POSTGRES_SERVABLE_COMMANDS, resetStore, STORE_ENV } from "../../../apps/cli/src/db/store.ts";
import { jobRunRows } from "../../../apps/cli/src/jobs.ts";
import { MASTER_KEY_BYTES, MASTER_KEY_FILE_ENV, setSecret } from "../../../apps/cli/src/secrets.ts";

const PG_BUDGET = spawnBudget(4);

afterEach(async () => {
  // 337j: sqlite by name, because unset now means postgres (see apps/cli/test/preload.ts).
  process.env[STORE_ENV] = "sqlite";
  await resetStore();
});

describe("ob 337 pass 3: the coordination commands served from Postgres", () => {
  test(
    "lease and agent round-trip entirely on Postgres, and never create the SQLite file",
    async () => {
      const lease = await leaseRealPgDb();
      const dir = mkdtempSync(join(tmpdir(), "ob337-cli-coord-"));
      // A path that does NOT exist: if anything falls back to SQLite it has to create this to work, so
      // its continued absence at the end is the proof that nothing did.
      const dbPath = join(dir, "must-never-exist.sqlite");
      process.env[STORE_ENV] = "postgres";
      // cli.ts closes the singleton after every postgres-served invocation, so it is re-primed for each.
      const ob = async (...args: string[]) => {
        await getStore({ kind: "postgres", connection: lease.options as unknown as Record<string, unknown> });
        return runCli(dbPath, args);
      };
      try {
        // --- `ob lease acquire` ----------------------------------------------------------------------
        const acquired = await ob("lease", "acquire", "ticket:337", "--holder", "architect-acme", "--ttl", "1800", "--json");
        expect(acquired.code).toBe(0);
        expect(JSON.parse(acquired.out)).toMatchObject({ resource: "ticket:337", ok: true, holder: "architect-acme" });

        // A second holder is refused, and the refusal exits 1 rather than throwing: the contended path is
        // the one the whole primitive exists for, so it has to work on the new engine too.
        const denied = await ob("lease", "acquire", "ticket:337", "--holder", "architect-other", "--json");
        expect(denied.code).toBe(1);
        expect(JSON.parse(denied.out)).toMatchObject({ ok: false, hold: { holder: "architect-acme" } });

        // --- `ob lease status` -----------------------------------------------------------------------
        const status = await ob("lease", "--json");
        expect(status.code).toBe(0);
        const rows = JSON.parse(status.out) as Array<{ resource: string; holder: string; expired: boolean; ttl_s: number }>;
        expect(rows.map((r) => r.resource)).toEqual(["ticket:337"]);
        expect(rows[0]!.expired).toBe(false); // a real boolean, not a 0/1 out of Postgres
        expect(rows[0]!.ttl_s).toBe(1800);

        // --- `ob agent register --holder` ------------------------------------------------------------
        // The documented gate flow (#75/#136): the architect holds ticket:337 and dispatches a builder for
        // that same ticket, which registers UNDER the architect's hold and must not collide with it.
        const registered = await ob("agent", "register", "--id", "build-337c", "--ticket", "337", "--status", "working", "--holder", "architect-acme", "--json");
        expect(registered.code).toBe(0);
        expect(JSON.parse(registered.out)).toMatchObject({ id: "build-337c", ticket: "337", status: "working", ttl_s: 900 });
        // and the architect's hold is LEFT EXACTLY AS IT IS, not re-taken under the agent's id
        const afterRegister = JSON.parse((await ob("lease", "--json")).out) as Array<{ resource: string; holder: string }>;
        expect(afterRegister).toEqual([expect.objectContaining({ resource: "ticket:337", holder: "architect-acme" })]);

        // --- `ob agents` -----------------------------------------------------------------------------
        const agents = await ob("agents", "--json");
        expect(agents.code).toBe(0);
        expect((JSON.parse(agents.out) as Array<{ id: string }>).map((a) => a.id)).toEqual(["build-337c"]);

        // --- `ob agent active` -- the count() that arrives from Postgres as a string ------------------
        const active = await ob("agent", "active", "--within", "20", "--json");
        expect(active.code).toBe(0);
        expect(JSON.parse(active.out)).toEqual({ active: true, count: 1, within_min: 20 });
        expect(typeof (JSON.parse(active.out) as { count: unknown }).count).toBe("number");

        // --- `ob agent heartbeat` / `ob agent done` --------------------------------------------------
        const beat = await ob("agent", "heartbeat", "build-337c");
        expect(beat.code).toBe(0);
        const done = await ob("agent", "done", "build-337c", "--json");
        expect(done.code).toBe(0);
        expect(JSON.parse(done.out)).toMatchObject({ id: "build-337c", done: true });
        expect((JSON.parse((await ob("agents", "--json")).out) as unknown[]).length).toBe(0);

        // --- `ob lease release` ----------------------------------------------------------------------
        // The same --holder it acquired with (#75); a holder-less release matches nothing and exits 1.
        const wrongHolder = await ob("lease", "release", "ticket:337", "--holder", "someone-else");
        expect(wrongHolder.code).toBe(1);
        expect(wrongHolder.out).toContain("architect-acme");
        const released = await ob("lease", "release", "ticket:337", "--holder", "architect-acme", "--json");
        expect(released.code).toBe(0);
        expect(JSON.parse(released.out)).toMatchObject({ resource: "ticket:337", released: true });
        expect(JSON.parse((await ob("lease", "--json")).out)).toEqual([]);

        // Nothing ever opened a file: the whole exchange happened on Postgres.
        expect(existsSync(dbPath)).toBe(false);
      } finally {
        await lease.release();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    PG_BUDGET,
  );

  test(
    "`ob person` is served, so the 337 unported-store refuse is gone",
    async () => {
      // 456 ported person. The stand-in moving WAS the port working; the DATA unported class is now
      // empty, so this is the inverted assertion, not a new stand-in. Handler/routing coverage:
      // api-data-456.test.ts. Bare `ob person` is a usage error once the handler runs, so list.
      expect(POSTGRES_SERVABLE_COMMANDS.has("person")).toBe(true);

      const lease = await leaseRealPgDb();
      const dir = mkdtempSync(join(tmpdir(), "ob337-cli-person-served-"));
      const dbPath = join(dir, "must-never-exist.sqlite");
      process.env[STORE_ENV] = "postgres";
      const ob = async (...args: string[]) => {
        await getStore({ kind: "postgres", connection: lease.options as unknown as Record<string, unknown> });
        return runCli(dbPath, args);
      };
      try {
        const res = await ob("person", "list");
        expect(res.code).toBe(0);
        expect(res.err).not.toContain("these ARE servable from Postgres today");
        expect(res.err).not.toContain("it is not ported to the store seam yet (ob 337)");
        expect(existsSync(dbPath)).toBe(false);
      } finally {
        await lease.release();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    PG_BUDGET,
  );

  // 1615: `ob cert` reads its config rows through the store, so the API host can issue the LAN certificate.
  test(
    "`ob cert` reads tls_domain/tls_dir from Postgres and never opens a file",
    async () => {
      const lease = await leaseRealPgDb();
      const dir = mkdtempSync(join(tmpdir(), "ob1615-cli-cert-"));
      const dbPath = join(dir, "must-never-exist.sqlite");
      const tlsDir = join(dir, "tls");
      process.env[STORE_ENV] = "postgres";
      const ob = async (...args: string[]) => {
        await getStore({ kind: "postgres", connection: lease.options as unknown as Record<string, unknown> });
        return runCli(dbPath, args);
      };
      try {
        const unconfigured = await ob("cert", "status");
        expect(unconfigured.code).toBe(0);
        expect(unconfigured.out).toContain("TLS is not configured");

        expect((await ob("config", "set", "tls_domain", "ob.example.test")).code).toBe(0);
        expect((await ob("config", "set", "tls_dir", tlsDir)).code).toBe(0);
        const status = await ob("cert", "status", "--json");
        // OB-1933: a configured but unissued certificate is a problem, so status exits 1 (still printing).
        expect(status.code).toBe(1);
        expect(JSON.parse(status.out)).toMatchObject({
          domain: "ob.example.test",
          certPath: join(tlsDir, "fullchain.pem"),
          issued: false,
        });

        // renew reaches the tls_email check, i.e. it read the domain row off Postgres; no lego runs.
        const renew = await ob("cert", "renew");
        expect(renew.code).not.toBe(0);
        expect(renew.err).toContain("tls_email");

        expect(existsSync(dbPath)).toBe(false);
      } finally {
        await lease.release();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    PG_BUDGET,
  );

  // 1646: `ob cloudflare` is servable, so the daily tunnel-check job runs on the API host instead of refusing. The
  // secrets come off the Postgres secret table, the job row lands on the Postgres job_run table, and the
  // Cloudflare HTTP is faked, so nothing reaches the network and no SQLite file is ever created.
  test(
    "`ob cloudflare` reads its secrets and records the tunnel-check job row on Postgres, never opening a file",
    async () => {
      expect(POSTGRES_SERVABLE_COMMANDS.has("cloudflare")).toBe(true);
      const lease = await leaseRealPgDb();
      const dir = mkdtempSync(join(tmpdir(), "ob1646-cli-cloudflare-"));
      const dbPath = join(dir, "must-never-exist.sqlite");
      const keyPath = join(dir, "master.key");
      const key = randomBytes(MASTER_KEY_BYTES);
      writeFileSync(keyPath, `${key.toString("base64")}\n`);
      chmodSync(keyPath, 0o600);
      const prevKey = process.env[MASTER_KEY_FILE_ENV];
      process.env[MASTER_KEY_FILE_ENV] = keyPath;
      process.env[STORE_ENV] = "postgres";
      const pgOptions = { kind: "postgres", connection: lease.options as unknown as Record<string, unknown> } as const;

      let versions = ["2026.10.4"];
      const cloudflareFetch = (async (input: string | URL | Request) => {
        const url = String(input);
        const path = url.replace("https://api.cloudflare.com/client/v4", "").split("?")[0]!;
        const ok = (result: unknown) =>
          new Response(JSON.stringify({ success: true, errors: [], result, result_info: { page: 1, total_pages: 1 } }), { status: 200 });
        if (path === "/zones") return ok([{ id: "z".repeat(32), name: "example.com", status: "active" }]);
        if (path === "/zones/" + "z".repeat(32) + "/dns_records") return ok([]);
        if (path === "/accounts/acct-1646/cfd_tunnel") return ok(versions.map((_, i) => ({ id: `t${i}`, name: `tunnel-${i}`, status: "healthy", conns: [] })));
        const m = path.match(/^\/accounts\/acct-1646\/cfd_tunnel\/(t\d+)\/connections$/);
        if (m) {
          const v = versions[Number(m[1]!.slice(1))]!;
          return ok([{ id: "c", version: v, conns: [{ client_version: v }] }]);
        }
        return new Response(JSON.stringify({ success: false, errors: [{ code: 7003, message: "no route" }], result: null }), { status: 404 });
      }) as unknown as typeof fetch;

      const ob = async (...args: string[]) => {
        await getStore(pgOptions);
        return runCli(dbPath, args, { cloudflareFetch });
      };
      const jobRow = async () => {
        const rows = await jobRunRows(await getStore(pgOptions));
        await resetStore();
        return rows.find((r) => r.job === "tunnel-check");
      };
      try {
        // The token and account id live in the Postgres secret table, written the way `ob secret set` does.
        const seed = await getStore(pgOptions);
        await setSecret(seed, "cloudflare-api-token", "cf-token-1646", key);
        await setSecret(seed, "cloudflare-account-id", "acct-1646", key);
        await resetStore();

        // The read subcommands reach the secret table too.
        const zones = await ob("cloudflare", "zones", "--json");
        expect(zones.code).toBe(0);
        expect(JSON.parse(zones.out)).toMatchObject([{ name: "example.com" }]);
        const dns = await ob("cloudflare", "dns", "list", "example.com", "--json");
        expect(dns.code).toBe(0);

        // A clean tunnel-check records a success row on the Postgres store.
        const clean = await ob("cloudflare", "tunnels");
        expect(clean.code).toBe(0);
        expect(clean.out).toContain("tunnel-0");
        const ok = await jobRow();
        expect(ok).toBeDefined();
        expect(ok!.last_success_at).not.toBeNull();
        expect(ok!.consecutive_failures).toBe(0);

        // A drifting connector exits 1 and the job row counts the failure, as the JOB FAILING alert needs.
        versions = ["2026.10.4", "2026.8.2"];
        const stale = await ob("cloudflare", "tunnels");
        expect(stale.code).toBe(1);
        expect(stale.out).toContain("STALE");
        const failed = await jobRow();
        expect(failed!.consecutive_failures).toBe(1);

        expect(existsSync(dbPath)).toBe(false);
      } finally {
        if (prevKey === undefined) delete process.env[MASTER_KEY_FILE_ENV];
        else process.env[MASTER_KEY_FILE_ENV] = prevKey;
        await lease.release();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    PG_BUDGET,
  );

  // pass 5: `ob spinoff` is on the list now, which is what makes a cut-over tracker able to DISPATCH
  // work rather than only record it. The queue half was proven in pass 3; this is the command reaching
  // it through cli.ts, plus the one subcommand that must still refuse.
  test(
    "`ob spinoff` enqueues and lists entirely on Postgres, and `watch` refuses by name",
    async () => {
      const lease = await leaseRealPgDb();
      const dir = mkdtempSync(join(tmpdir(), "ob337-cli-spinoff-"));
      const dbPath = join(dir, "must-never-exist.sqlite");
      const repo = join(dir, "acme");
      mkdirSync(join(repo, ".git"), { recursive: true });
      process.env[STORE_ENV] = "postgres";
      const ob = async (...args: string[]) => {
        await getStore({ kind: "postgres", connection: lease.options as unknown as Record<string, unknown> });
        return runCli(dbPath, args);
      };
      try {
        const queued = await ob("spinoff", "queue", "--no-check", "a test fixture", "337", "--repo", repo, "--branch", "build-337z", "--json");
        expect(queued.code).toBe(0);
        expect(JSON.parse(queued.out)).toMatchObject({ ticket: "337", status: "queued" });

        const listed = await ob("spinoff", "list", "--json");
        expect(listed.code).toBe(0);
        const rows = JSON.parse(listed.out) as Array<{ ticket_ref: string; status: string; repo: string }>;
        expect(rows.map((r) => [r.ticket_ref, r.status])).toEqual([["337", "queued"]]);
        expect(rows[0]!.repo).toBe(repo); // --repo resolved through repo_checkouts/the cwd, on the store

        // `spinoff brief` composes from the store too (the architect grouping read), and writes nothing.
        const brief = await ob("spinoff", "brief", "337", "--repo", repo, "--json");
        expect(brief.code).toBe(0);
        expect(JSON.parse(brief.out)).toMatchObject({ ticket: "337" });

        // The one sqlite-only subcommand: it must say so rather than block forever reporting nothing.
        const watch = await ob("spinoff", "watch", "--once");
        expect(watch.code).toBe(1);
        expect(watch.err).toContain("watches the SQLite database FILE");
        expect(watch.err).toContain(`${STORE_ENV}=sqlite`);

        // Nothing ever opened a file: the whole exchange happened on Postgres.
        expect(existsSync(dbPath)).toBe(false);
      } finally {
        await lease.release();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    PG_BUDGET,
  );
});
