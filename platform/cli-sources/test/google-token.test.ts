import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import { freshDb } from "../../../apps/cli/test/helpers.ts";
import { freshPgStore } from "../../../apps/cli/test/pg/store.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";

const PG_BUDGET = spawnBudget(2);
import { setConfig } from "../../../apps/cli/src/config.ts";
import { readGoogleToken } from "../src/google.ts";
import { syncGmail } from "../src/ingest/gmail.ts";
import { syncCalendar } from "../src/ingest/calendar.ts";
import { AppError } from "../../../apps/cli/src/errors.ts";

function tmpPath(): string {
  return join(tmpdir(), `ob-gtok-${randomUUID()}.json`);
}

describe("google token loader / auth stub (125)", () => {
  test("readGoogleToken parses a stored token file", () => {
    const p = tmpPath();
    writeFileSync(p, JSON.stringify({ access_token: "at", refresh_token: "rt", expiry: "2999-01-01T00:00:00Z" }));
    const t = readGoogleToken(p);
    expect(t.access_token).toBe("at");
    expect(t.refresh_token).toBe("rt");
    rmSync(p, { force: true });
  });

  test("readGoogleToken throws a clean AppError when the file is absent", () => {
    let err: unknown;
    try {
      readGoogleToken(tmpPath());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    expect((err as Error).message).toContain("cannot read Google token");
  });

  test("readGoogleToken rejects malformed JSON and empty tokens cleanly", () => {
    const bad = tmpPath();
    writeFileSync(bad, "not json");
    expect(() => readGoogleToken(bad)).toThrow(AppError);
    rmSync(bad, { force: true });

    const empty = tmpPath();
    writeFileSync(empty, JSON.stringify({ client_id: "x" }));
    expect(() => readGoogleToken(empty)).toThrow(/neither access_token nor refresh_token/);
    rmSync(empty, { force: true });
  });

  test("gmail sync fails cleanly (no crash, no network) when the token file is missing", async () => {
    const lease = await freshPgStore();
    await setConfig(lease.store, "google_token_path", tmpPath()); // guaranteed-absent path (never the live ~/.google_token)
    await expect(syncGmail(lease.store, {})).rejects.toThrow(/cannot read Google token/);
    await lease.release();
  }, PG_BUDGET);

  test("cal sync fails cleanly (no crash, no network) when the token file is missing", async () => {
    const lease = await freshPgStore();
    await setConfig(lease.store, "google_token_path", tmpPath());
    await expect(syncCalendar(lease.store, {})).rejects.toThrow(/cannot read Google token/);
    await lease.release();
  }, PG_BUDGET);
});
