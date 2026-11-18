import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { sqliteStoreFor } from "../../../apps/cli/src/db/store.ts";
import { credentialInventory, lastCredentialCheck, lastCredentialChecks } from "../../../apps/cli/src/credentials.ts";
import { pushWorthy } from "../../../apps/cli/src/commands/alerts.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";
import { inMemoryMasterKey, setSecret } from "../../../apps/cli/src/secrets.ts";

// ob 1655. The daily creds-check job runs `ob creds check --all` at 07:45 and the 08:00 `ob alerts --digest
// --notify` turns whatever is wrong into ONE Home Assistant push. A revoked token has to be a failed job
// (exit 1, a JOB FAILING alert beside gmail-sync) AND a failed credential_check row, the job must name WHICH
// credential failed, and no token may appear in any output, recorded detail or push. Providers and Home
// Assistant are fake `fetch`es: no live network, no real token, nothing reaches a phone.

const GITHUB_TOKEN = "ghp_THIS_MUST_NEVER_BE_RENDERED_1655_0123456789";
const HA_TOKEN = "ha_THIS_MUST_NEVER_BE_PUSHED_1655_9876543210";

function seam() {
  const dir = mkdtempSync(join(tmpdir(), "ob-1655-"));
  const keyFile = join(dir, "master.key");
  writeFileSync(keyFile, inMemoryMasterKey().get().toString("base64"), { mode: 0o600 });
  return { dbPath: freshDbPath(), keyFile };
}

async function seed(dbPath: string, secrets: Record<string, string>): Promise<void> {
  const db = openDb(dbPath);
  for (const [name, value] of Object.entries(secrets)) await setSecret(sqliteStoreFor(db), name, value, inMemoryMasterKey().get());
  await setConfig(db, "ha_host", "ha.test");
  await setConfig(db, "ha_notify_service", "mobile_app_phone");
  db.close();
}

async function withKey<T>(keyFile: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.OMNISLASH_MASTER_KEY_FILE;
  process.env.OMNISLASH_MASTER_KEY_FILE = keyFile;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.OMNISLASH_MASTER_KEY_FILE;
    else process.env.OMNISLASH_MASTER_KEY_FILE = prev;
  }
}

/** A provider that answers `status`, echoing the bearer token back in an error body like a careless proxy. */
function fakeProvider(status: number, calls: string[] = []) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(String(input));
    const bearer = new Headers(init?.headers).get("authorization") ?? "";
    const body = status === 200 ? { login: "alex-example" } : { message: `Bad credentials (${bearer})` };
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

interface Push {
  url: string;
  auth: string;
  body: { title: string; message: string };
}

/** A Home Assistant that records every push it is sent and answers `status`. */
function fakeHa(status = 200) {
  const pushes: Push[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    pushes.push({
      url: String(input),
      auth: new Headers(init?.headers).get("authorization") ?? "",
      body: JSON.parse(String(init?.body)),
    });
    return new Response("[]", { status });
  }) as unknown as typeof fetch;
  return { pushes, fetchFn };
}

const jobRow = async (dbPath: string) => {
  const listed = await runCli(dbPath, ["jobs", "--json"]);
  return (JSON.parse(listed.out) as Array<{ job: string; consecutive_failures: number; last_success_at: string | null }>).find(
    (r) => r.job === "creds-check",
  )!;
};

const recordedRows = async (dbPath: string) => {
  const db = openDb(dbPath);
  try {
    return await lastCredentialChecks(sqliteStoreFor(db));
  } finally {
    db.close();
  }
};

const checkableNames = async (dbPath: string): Promise<string[]> => {
  const db = openDb(dbPath);
  try {
    return (await credentialInventory(sqliteStoreFor(db))).filter((c) => c.checkable).map((c) => c.name);
  } finally {
    db.close();
  }
};

describe("ob creds check --all as the daily creds-check job (1655)", () => {
  test("every checkable spec is checked and recorded, whatever the specs are today", async () => {
    const { dbPath, keyFile } = seam();
    await seed(dbPath, { github: GITHUB_TOKEN });
    const r = await withKey(keyFile, () => runCli(dbPath, ["creds", "check", "--all"], { credsFetch: fakeProvider(200) }));
    const names = await checkableNames(dbPath);
    // A spec added later (OB-1656's opencode ones) is in this list with no change to the job.
    expect(names.length).toBeGreaterThan(1);
    expect((await recordedRows(dbPath)).map((row) => row.name).sort()).toEqual([...names].sort());
    for (const name of names) expect(r.out).toContain(name);
  });

  test("one rejected token fails the job (exit 1), is recorded FAILED, and the job names it; the token appears nowhere", async () => {
    const { dbPath, keyFile } = seam();
    await seed(dbPath, { github: GITHUB_TOKEN });
    const r = await withKey(keyFile, () => runCli(dbPath, ["creds", "check", "--all"], { credsFetch: fakeProvider(401) }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/\d+ of \d+ FAILED: .*github/);
    expect(r.out).toContain("HTTP 401");
    const check = await lastCredentialCheckOf(dbPath, "github");
    expect(check?.ok).toBe(false);
    const row = await jobRow(dbPath);
    expect(row.consecutive_failures).toBe(1);
    const jobs = await runCli(dbPath, ["jobs"]);
    for (const text of [r.out, r.err, JSON.stringify(await recordedRows(dbPath)), JSON.stringify(row), jobs.out, jobs.err]) {
      expect(text).not.toContain(GITHUB_TOKEN);
    }
  });

  test("no stored token is a failed verdict and a failed job, with no call to the provider", async () => {
    const { dbPath, keyFile } = seam();
    openDb(dbPath).close();
    const calls: string[] = [];
    const r = await withKey(keyFile, () => runCli(dbPath, ["creds", "check", "github"], { credsFetch: fakeProvider(200, calls) }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("not in the store");
    expect(calls).toEqual([]);
    expect((await lastCredentialCheckOf(dbPath, "github"))?.ok).toBe(false);
  });

  test("a thrown fetch that names a query token is recorded FAILED with the token blanked", async () => {
    const { dbPath, keyFile } = seam();
    await seed(dbPath, { github: GITHUB_TOKEN });
    const boom = (async () => {
      throw new Error(`Unable to connect to https://oauth2.googleapis.com/tokeninfo?access_token=${GITHUB_TOKEN}&x=1`);
    }) as unknown as typeof fetch;
    const r = await withKey(keyFile, () => runCli(dbPath, ["creds", "check", "--all"], { credsFetch: boom }));
    const row = await lastCredentialCheckOf(dbPath, "github");
    expect(r.code).toBe(1);
    expect(row?.ok).toBe(false);
    expect(row?.detail).toContain("access_token=[redacted]");
    expect(r.out + r.err + (row?.detail ?? "")).not.toContain(GITHUB_TOKEN);
  });
});

async function lastCredentialCheckOf(dbPath: string, name: string) {
  const db = openDb(dbPath);
  try {
    return await lastCredentialCheck(sqliteStoreFor(db), name);
  } finally {
    db.close();
  }
}

/** One urgent task untouched since 2020: rule 2 (aging) fires for it, and it must never reach the phone (1687). */
async function seedAgingItem(dbPath: string): Promise<void> {
  const db = openDb(dbPath);
  const store = sqliteStoreFor(db);
  await store.q.insert(store.t.item).values({
    id: "old-1", type: "task", title: "Ancient urgent thing", status: "todo", priority: 1,
    created_at: "2020-01-01T00:00:00.000Z", updated_at: "2020-01-01T00:00:00.000Z",
  });
  db.close();
}

describe("ob alerts --digest --notify is the ONE morning push (1655)", () => {
  /** A box with an ha token and TWO failed verdicts (github rejected, the rest absent) to alert on. */
  async function alerting() {
    const { dbPath, keyFile } = seam();
    await seed(dbPath, { github: GITHUB_TOKEN, ha: HA_TOKEN });
    await withKey(keyFile, () => runCli(dbPath, ["creds", "check", "--all"], { credsFetch: fakeProvider(401) }));
    return { dbPath, keyFile };
  }

  test("several failures go out as exactly ONE push carrying every alert", async () => {
    const { dbPath, keyFile } = await alerting();
    const ha = fakeHa();
    const r = await withKey(keyFile, () => runCli(dbPath, ["alerts", "--digest", "--notify"], { notifyFetch: ha.fetchFn }));
    expect(r.code).toBe(0);
    expect(ha.pushes.length).toBe(1);
    const push = ha.pushes[0]!;
    expect(push.url).toBe("http://ha.test:8123/api/services/notify/mobile_app_phone");
    expect(push.auth).toBe(`Bearer ${HA_TOKEN}`);
    // What the journal printed is what the phone gets: every alert, in the one message.
    const alertLines = r.out.split("\n").filter((l) => l.startsWith("•"));
    expect(alertLines.length).toBeGreaterThan(1);
    for (const line of alertLines) expect(push.body.message).toContain(line);
    expect(push.body.title).toBe(`OmniSlash: ${alertLines.length} alerts`);
  });

  test("only alerts that need action are pushed: aging and overdue contact print but never buzz (1687)", async () => {
    const { dbPath, keyFile } = await alerting();
    await seedAgingItem(dbPath); // an aging urgent item beside the credential failures
    const ha = fakeHa();
    const r = await withKey(keyFile, () => runCli(dbPath, ["alerts", "--digest", "--notify"], { notifyFetch: ha.fetchFn }));
    expect(r.code).toBe(0);
    expect(r.out).toContain("[aging]"); // still in the printed digest
    expect(ha.pushes.length).toBe(1);
    expect(ha.pushes[0]!.body.message).not.toContain("[aging]");
    expect(ha.pushes[0]!.body.message).toContain("[credential invalid]");
  });

  test("a morning with only aging alerts sends nothing (1687)", async () => {
    const { dbPath, keyFile } = seam();
    await seed(dbPath, { ha: HA_TOKEN });
    await seedAgingItem(dbPath);
    const ha = fakeHa();
    const r = await withKey(keyFile, () => runCli(dbPath, ["alerts", "--digest", "--notify"], { notifyFetch: ha.fetchFn }));
    expect(r.code).toBe(0);
    expect(r.out).toContain("[aging]");
    expect(ha.pushes).toEqual([]);
  });

  test("pushworthy rules: jobs, credentials and blocked yes; aging, overdue contact, PR and branch nudges no (1687)", () => {
    const mk = (rule: number) => ({ key: `k${rule}`, rule, label: "x", entity: "e", message: "m", state_hash: "h" });
    const pushed = pushWorthy([1, 2, 3, 4, 6, 7, 8, 9, 10, 11].map(mk)).map((a) => a.rule);
    expect(pushed).toEqual([4, 7, 8, 9, 10, 11]);
  });

  test("a clean morning sends nothing", async () => {
    const { dbPath, keyFile } = seam();
    await seed(dbPath, { ha: HA_TOKEN });
    const ha = fakeHa();
    const r = await withKey(keyFile, () => runCli(dbPath, ["alerts", "--digest", "--notify"], { notifyFetch: ha.fetchFn }));
    expect(r.code).toBe(0);
    expect(r.out).toContain("no alerts");
    expect(ha.pushes).toEqual([]);
  });

  test("without --notify the digest only prints: a person typing it does not buzz their phone", async () => {
    const { dbPath, keyFile } = await alerting();
    const ha = fakeHa();
    const r = await withKey(keyFile, () => runCli(dbPath, ["alerts", "--digest"], { notifyFetch: ha.fetchFn }));
    expect(r.code).toBe(0);
    expect(ha.pushes).toEqual([]);
  });

  test("the creds job itself never pushes", async () => {
    const { dbPath, keyFile } = seam();
    await seed(dbPath, { github: GITHUB_TOKEN, ha: HA_TOKEN });
    const ha = fakeHa();
    await withKey(keyFile, () => runCli(dbPath, ["creds", "check", "--all"], { credsFetch: fakeProvider(401), notifyFetch: ha.fetchFn }));
    expect(ha.pushes).toEqual([]);
  });

  test("Home Assistant refusing the push fails the job without echoing the token", async () => {
    const { dbPath, keyFile } = await alerting();
    const ha = fakeHa(401);
    const r = await withKey(keyFile, () => runCli(dbPath, ["alerts", "--digest", "--notify"], { notifyFetch: ha.fetchFn }));
    expect(r.code).toBe(1);
    expect(r.err).toContain("HTTP 401");
    expect(r.out + r.err).not.toContain(HA_TOKEN);
  });

  test("no ha token in the store fails the job with a plain reason", async () => {
    const { dbPath, keyFile } = seam();
    await seed(dbPath, { github: GITHUB_TOKEN });
    await withKey(keyFile, () => runCli(dbPath, ["creds", "check", "--all"], { credsFetch: fakeProvider(401) }));
    const ha = fakeHa();
    const r = await withKey(keyFile, () => runCli(dbPath, ["alerts", "--digest", "--notify"], { notifyFetch: ha.fetchFn }));
    expect(r.code).toBe(1);
    expect(r.err).toContain("no `ha` token");
    expect(ha.pushes).toEqual([]);
  });
});
