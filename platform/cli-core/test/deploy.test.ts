// ob 582: the deploy record -- `ob deploy status` / `ob deploy record` on the direct (sqlite) path.
// The API half lives in api-deploy-582.test.ts; the db-migration e2e covers the table's migration.
import { describe, expect, test } from "bun:test";
import { countSpawns, freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import {
  LIVE_DEPLOY_UNKNOWN,
  liveDeploySshArgv,
  runLiveDeploy,
} from "../../../apps/cli/src/commands/deploy.ts";

const SHA_A = "320207e9a1b2c3d4e5f60718293a4b5c6d7e8f901";
const SHA_B = "0dfd09b9c8d7e6f5a4b3c2d1e0f1029384756aabb";

describe("ob deploy status (582)", () => {
  test("with no records, status says so and --json is an empty array", async () => {
    const path = freshDbPath();
    const r = await runCli(path, ["deploy", "status"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("no deploys recorded yet");
    const j = await runCli(path, ["deploy", "status", "--json"]);
    expect(j.code).toBe(0);
    expect(JSON.parse(j.out)).toEqual([]);
  });

  test("record then status shows target, host, unit, sha, at, result", async () => {
    const path = freshDbPath();
    const rec = await runCli(path, [
      "deploy",
      "record",
      "--target", "live",
      "--host", "api-host",
      "--unit", "omnislash-web.service",
      "--sha", SHA_A,
      "--result", "ok",
      "--at", "2026-09-03T12:00:00.000Z",
    ]);
    expect(rec.code).toBe(0);
    expect(rec.out).toContain("recorded ok for live @ 320207e9");

    const r = await runCli(path, ["deploy", "status"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("live");
    expect(r.out).toContain("api-host");
    expect(r.out).toContain("omnislash-web.service");
    expect(r.out).toContain(SHA_A);
    expect(r.out).toContain("2026-09-03T12:00:00.000Z");
    expect(r.out).toContain("ok");

    const j = await runCli(path, ["deploy", "status", "--json"]);
    expect(j.code).toBe(0);
    expect(JSON.parse(j.out)).toEqual([
      {
        target: "live",
        host: "api-host",
        unit: "omnislash-web.service",
        sha: SHA_A,
        at: "2026-09-03T12:00:00.000Z",
        result: "ok",
      },
    ]);
  });

  test("bare `deploy` is a status, and status -q prints targets only", async () => {
    const path = freshDbPath();
    await runCli(path, ["deploy", "record", "--target", "live", "--host", "api-host", "--unit", "omnislash-web.service", "--sha", SHA_A, "--result", "ok"]);
    const bare = await runCli(path, ["deploy"]);
    expect(bare.code).toBe(0);
    expect(bare.out).toContain("live");
    const q = await runCli(path, ["deploy", "status", "-q"]);
    expect(q.code).toBe(0);
    expect(q.out.trim()).toBe("live");
  });

  test("one row per target: a later record replaces the earlier one", async () => {
    const path = freshDbPath();
    // OB-1926: "later" is the `at`, not the call order: an older `at` would be a no-op.
    await runCli(path, ["deploy", "record", "--target", "live", "--host", "api-host", "--unit", "omnislash-web.service", "--sha", SHA_A, "--result", "ok", "--at", "2026-09-03T12:00:00.000Z"]);
    const rec = await runCli(path, [
      "deploy", "record", "--target", "live", "--host", "api-host", "--unit", "omnislash-web.service",
      "--sha", SHA_B, "--result", "rolled-back", "--at", "2026-09-03T13:00:00.000Z",
    ]);
    expect(rec.code).toBe(0);
    const rows = JSON.parse((await runCli(path, ["deploy", "status", "--json"])).out) as unknown[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      target: "live",
      host: "api-host",
      unit: "omnislash-web.service",
      sha: SHA_B,
      at: "2026-09-03T13:00:00.000Z",
      result: "rolled-back",
    });
  });

  test("two targets coexist (live + web-dev are separate rows)", async () => {
    const path = freshDbPath();
    await runCli(path, ["deploy", "record", "--target", "live", "--host", "api-host", "--unit", "omnislash-web.service", "--sha", SHA_A, "--result", "ok"]);
    await runCli(path, ["deploy", "record", "--target", "web-dev", "--host", "ob-host", "--unit", "omnislash-web-dev.service", "--sha", SHA_B, "--result", "ok"]);
    const rows = JSON.parse((await runCli(path, ["deploy", "status", "--json"])).out) as { target: string }[];
    expect(rows.map((r) => r.target).sort()).toEqual(["live", "web-dev"]);
  });

  test("record without --at stamps now (a no-op deploy still refreshes the row)", async () => {
    const path = freshDbPath();
    const rec = await runCli(path, ["deploy", "record", "--target", "live", "--host", "api-host", "--unit", "omnislash-web.service", "--sha", SHA_A, "--result", "ok"]);
    expect(rec.code).toBe(0);
    const row = (JSON.parse((await runCli(path, ["deploy", "status", "--json"])).out) as { at: string }[])[0]!;
    expect(row.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test("usage errors: unknown subcommand, missing fields, bad result", async () => {
    const path = freshDbPath();
    const unknown = await runCli(path, ["deploy", "frobnicate"]);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain("unknown deploy subcommand");
    expect(unknown.err).toContain("status|record|run");
    const missing = await runCli(path, ["deploy", "record", "--target", "live"]);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain("deploy record requires --host --unit --sha --result");
    const bad = await runCli(path, [
      "deploy", "record", "--target", "live", "--host", "api-host", "--unit", "omnislash-web.service",
      "--sha", SHA_A, "--result", "maybe",
    ]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("--result must be one of ok|rolled-back|refused");
  });
});

describe("ob deploy run (636)", () => {
  test("ssh argv is the locked fire-and-forget kick", () => {
    expect(liveDeploySshArgv()).toEqual([
      "ssh",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      "ob-host",
      "nohup env OMNISLASH_REPO=/opt/omnislash /opt/omnislash/bin/ob-deploy.sh >/tmp/ob-deploy.log 2>&1 &",
    ]);
  });

  // 1534: `--sha` pins the deploy. The pin travels in the kick's own environment, so it is enforced on
  // the server rather than here -- the argv is the whole contract.
  describe("--sha pins the deploy (1534)", () => {
    // Real commit ids are 40 hex; the 582 fixtures above are a character longer and would be rejected by
    // the pin's validation, which is itself worth knowing.
    const PIN_A = "320207e9a1b2c3d4e5f60718293a4b5c6d7e8f90";

    test("the pin rides the kick as OMNISLASH_DEPLOY_SHA, and nothing else changes", () => {
      const argv = liveDeploySshArgv(PIN_A);
      expect(argv).toEqual([
        "ssh",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=15",
        "ob-host",
        `nohup env OMNISLASH_REPO=/opt/omnislash OMNISLASH_DEPLOY_SHA=${PIN_A} /opt/omnislash/bin/ob-deploy.sh >/tmp/ob-deploy.log 2>&1 &`,
      ]);
    });

    test("--sha <sha> sends that argv and says which SHA it pinned", async () => {
      const path = freshDbPath();
      const sshCalls: string[][] = [];
      const r = await runCli(path, ["deploy", "run", "--sha", PIN_A], {
        deploySsh: (argv) => {
          sshCalls.push([...argv]);
          return { code: 0 };
        },
      });
      expect(r.code).toBe(0);
      expect(sshCalls).toEqual([[...liveDeploySshArgv(PIN_A)]]);
      expect(r.out).toContain(`pinned to ${PIN_A}`);
      const j = await runCli(path, ["deploy", "run", "--sha", PIN_A, "--json"], { deploySsh: () => ({ code: 0 }) });
      expect(JSON.parse(j.out)).toEqual({ kicked: true, target: "live", sha: PIN_A });
    });

    test("a short SHA is accepted; anything that is not a commit id never reaches ssh", async () => {
      const path = freshDbPath();
      const short = PIN_A.slice(0, 12);
      const ok = await runCli(path, ["deploy", "run", "--sha", short], { deploySsh: () => ({ code: 0 }) });
      expect(ok.code).toBe(0);

      let calls = 0;
      for (const bad of ["../../../etc/passwd", "HEAD", "abc", "ZZZZZZZZ", "0dfd09b; rm -rf /"]) {
        const r = await runCli(path, ["deploy", "run", "--sha", bad], {
          deploySsh: () => {
            calls += 1;
            return { code: 0 };
          },
        });
        expect(r.code, bad).toBe(2);
        expect(r.err, bad).toContain("--sha must be a commit id");
      }
      expect(calls).toBe(0);
    });
  });

  test("kicks ssh and returns without recording when ssh exits 0", async () => {
    const path = freshDbPath();
    const sshCalls: string[][] = [];
    const { result: r, spawned } = await countSpawns(() =>
      runCli(path, ["deploy", "run"], {
        deploySsh: (argv) => {
          sshCalls.push([...argv]);
          return { code: 0 };
        },
      }),
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("live deploy kicked");
    expect(sshCalls).toEqual([[...liveDeploySshArgv()]]);
    expect(spawned).toEqual([]);
    const rows = JSON.parse((await runCli(path, ["deploy", "status", "--json"])).out) as unknown[];
    expect(rows).toEqual([]);
  });

  test("--json on a successful kick is parseable", async () => {
    const path = freshDbPath();
    const r = await runCli(path, ["deploy", "run", "--json"], { deploySsh: () => ({ code: 0 }) });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ kicked: true, target: "live" });
  });

  test("ssh failure records refused from last known live row and exits 1", async () => {
    const path = freshDbPath();
    await runCli(path, [
      "deploy", "record", "--target", "live", "--host", "api-host", "--unit", "omnislash-web.service",
      "--sha", SHA_A, "--result", "ok", "--at", "2026-09-03T12:00:00.000Z",
    ]);
    const r = await runCli(path, ["deploy", "run"], { deploySsh: () => ({ code: 255 }) });
    expect(r.code).toBe(1);
    expect(r.err).toContain("ssh to ob-host failed");
    expect(r.err).toContain("recorded refused for live");
    const row = (JSON.parse((await runCli(path, ["deploy", "status", "--json"])).out) as Array<{
      target: string; host: string; unit: string; sha: string; result: string;
    }>)[0]!;
    expect(row).toMatchObject({
      target: "live",
      host: "api-host",
      unit: "omnislash-web.service",
      sha: SHA_A,
      result: "refused",
    });
    expect(row.sha).toBe(SHA_A);
  });

  test("ssh failure with no live row uses locked placeholders", async () => {
    const path = freshDbPath();
    const r = await runCli(path, ["deploy", "run"], { deploySsh: () => ({ code: 1 }) });
    expect(r.code).toBe(1);
    const row = (JSON.parse((await runCli(path, ["deploy", "status", "--json"])).out) as Array<{
      target: string; host: string; unit: string; sha: string; result: string;
    }>)[0]!;
    expect(row).toMatchObject({
      target: "live",
      host: LIVE_DEPLOY_UNKNOWN.host,
      unit: LIVE_DEPLOY_UNKNOWN.unit,
      sha: LIVE_DEPLOY_UNKNOWN.sha,
      result: "refused",
    });
  });

  test("runLiveDeploy seam records nothing on success and the refused row on failure", async () => {
    const recorded: unknown[] = [];
    const ok = await runLiveDeploy({
      list: async () => [],
      record: async (input) => {
        recorded.push(input);
      },
      ssh: () => ({ code: 0 }),
    });
    expect(ok).toEqual({ kicked: true });
    expect(recorded).toEqual([]);

    const fail = await runLiveDeploy({
      list: async () => [],
      record: async (input) => {
        recorded.push(input);
      },
      ssh: () => ({ code: 1 }),
    });
    expect(fail.kicked).toBe(false);
    expect(recorded).toEqual([
      {
        target: "live",
        host: LIVE_DEPLOY_UNKNOWN.host,
        unit: LIVE_DEPLOY_UNKNOWN.unit,
        sha: LIVE_DEPLOY_UNKNOWN.sha,
        result: "refused",
      },
    ]);
  });
});