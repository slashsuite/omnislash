import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HANDLERS, run } from "../../../apps/cli/src/cli.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import {
  isReadInvocation,
  isSplitInvocation,
  planExecution,
  refusalWhy,
  REFUSED_COMMANDS,
  SPLIT_COMMANDS,
  type RemoteExec,
} from "../../../apps/cli/src/remote.ts";
import { dumpReplicaBytes, gunzip, readMeta, replicaPath, replicaToken } from "../../../apps/cli/src/replica.ts";
import { cliDocs } from "../../../apps/cli/test/support/cli-docs.ts";

// ob 189: the SPLIT class -- a command whose side effect runs HERE and whose database half runs on the
// server. Nothing in this file shells out to ssh, spawns a session or touches the network: the spawn is
// seamed and every remote interaction goes through the injected RemoteExec 183 added.

interface FakeServer extends RemoteExec {
  calls: string[][];
  reachable: boolean;
  failWrite: boolean;
}

/** A fake server: a real local DB that answers `replica token`/`dump` and APPLIES the sub-invocations. */
function fakeServer(serverDbPath: string): FakeServer {
  const serverDb = openDb(serverDbPath);
  const fake: FakeServer = {
    calls: [],
    reachable: true,
    failWrite: false,
    stream(_host, argv) {
      fake.calls.push(argv);
      if (!fake.reachable) return { code: 255, connectionFailed: true };
      return { code: 0, connectionFailed: false };
    },
    capture(_host, argv) {
      fake.calls.push(argv);
      if (!fake.reachable) return { code: 255, connectionFailed: true, stdout: "", stderr: "" };
      if (argv[0] === "replica" && argv[1] === "token") {
        return { code: 0, connectionFailed: false, stdout: `${replicaToken(serverDbPath)}\n`, stderr: "" };
      }
      if (fake.failWrite) {
        return { code: 1, connectionFailed: false, stdout: "", stderr: "error: the server said no\n" };
      }
      // Apply the sub-invocation for real, against the server's own database, so the assertions read the
      // row the server actually holds rather than a stub's idea of it.
      if (argv[0] === "agent" && argv[1] === "register") {
        const at = (name: string): string | undefined => {
          const i = argv.indexOf(`--${name}`);
          return i === -1 ? undefined : argv[i + 1];
        };
        serverDb
          .query(
            "INSERT INTO agent (id, status, worktree, launcher, session_id, started_at, heartbeat_at, ttl_s) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?)",
          )
          .run(at("id")!, at("status")!, at("worktree")!, at("launcher")!, at("session")!, Number(at("ttl")));
        return { code: 0, connectionFailed: false, stdout: "", stderr: "" };
      }
      return { code: 0, connectionFailed: false, stdout: "", stderr: "" };
    },
    fetch(_host, argv) {
      fake.calls.push(argv);
      if (!fake.reachable) return { code: 255, connectionFailed: true, stderr: "", bytes: new Uint8Array() };
      return { code: 0, connectionFailed: false, stderr: "", bytes: dumpReplicaBytes(serverDb) };
    },
  };
  return fake;
}

function clientDir(): string {
  return mkdtempSync(join(tmpdir(), "ob-split-"));
}

/** `runCli`, plus the injected ssh seam. */
async function runCliWith(
  dbPath: string,
  args: string[],
  exec: RemoteExec,
): Promise<{ code: number; out: string; err: string }> {
  const prevDb = process.env.OMNISLASH_DB;
  const origLog = console.log;
  const origErr = process.stderr.write.bind(process.stderr);
  let out = "";
  let err = "";
  console.log = (...a: unknown[]) => {
    out += a.join(" ") + "\n";
  };
  (process.stderr.write as unknown) = (chunk: string) => {
    err += chunk;
    return true;
  };
  process.env.OMNISLASH_DB = dbPath;
  try {
    const code = await run(args, { exec });
    return { code, out, err };
  } finally {
    console.log = origLog;
    (process.stderr.write as unknown) = origErr;
    if (prevDb === undefined) delete process.env.OMNISLASH_DB;
    else process.env.OMNISLASH_DB = prevDb;
  }
}

describe("split class: classification (189)", () => {
  test("every HANDLERS command still lands in exactly one class, split included", () => {
    // 183's exhaustiveness test, extended rather than worked around: a command added later must still be
    // reachable by the architect, and the safe default is still REMOTE.
    const known = new Set(["local", "replica", "remote", "nodb", "split", "refused"]);
    const unclassified = Object.keys(HANDLERS).filter(
      (command) => !known.has(planExecution({ command, args: [], flags: {}, host: "ob@server" }).mode),
    );
    expect(unclassified).toEqual([]);
  });

  test("the split and refusal tables only name commands that exist", () => {
    const unknown = [...Object.keys(SPLIT_COMMANDS), ...Object.keys(REFUSED_COMMANDS)].filter((c) => !(c in HANDLERS));
    expect(unknown).toEqual([]);
  });

  test("no invocation is both an allowlisted read and a split command", () => {
    // The read allowlist and the split table must not overlap: an overlap would make the answer depend on
    // check order, which is exactly the ambiguity the tables exist to remove.
    expect(isReadInvocation("whois", [], {})).toBe(true);
    expect(isSplitInvocation("whois", [])).toBe(false);
    expect(isSplitInvocation("spinoff", ["drain"])).toBe(true);
    expect(isReadInvocation("spinoff", ["drain"], {})).toBe(false);
    expect(isReadInvocation("spinoff", ["list"], {})).toBe(true);
  });

  test("the members of the class are the ones whose side effect is this machine", () => {
    for (const [command, args] of [
      ["daemon", []],
      ["daemon", ["install"]],
      ["web", []],
      // 191: the three spinoff sweeps, once their database half was separable into steps
      ["spinoff", ["drain"]],
      ["spinoff", ["cleanup"]],
      ["spinoff", ["reconcile"]],
      // 1589: the bare enqueue opens its T3 thread here, so its DB half crosses and its launch does not
      ["spinoff", ["189"]],
    ] as [string, string[]][]) {
      expect(planExecution({ command, args, flags: {}, host: "h" }).mode).toBe("split");
    }
  });

  test("the candidates that turned out NOT to belong stay remote", () => {
    // `ob spinoff queue <ticket>` only queues a row (1589: the bare `ob spinoff <ticket>` launches and is
    // split) and leftover writes stay a DB row plus a best-effort browser tab, so both are pure writes and
    // correctly remote.
    for (const [command, args] of [
      ["spinoff", ["queue", "189"]],
      ["standup", ["generate"]],
      ["standup", ["posted"]],
    ] as [string, string[]][]) {
      expect(planExecution({ command, args, flags: {}, host: "h" }).mode).toBe("remote");
    }
  });

  test("spinoff show is a read, not an enqueue", () => {
    expect(isReadInvocation("spinoff", ["show"], {})).toBe(true);
    expect(isReadInvocation("spinoff", ["show", "1"], {})).toBe(true);
    expect(isReadInvocation("spinoff", ["189"], {})).toBe(false);
    expect(planExecution({ command: "spinoff", args: ["show", "1"], flags: {}, host: "h" }).mode).toBe("replica");
  });

  test("only `ports` and `lease run` are refused: 191 separated the spinoff member, 2041 and 2071 added the ones that cannot split", () => {
    // 189 refused `spinoff drain|cleanup`. 191 gave drain a claim/stamp protocol and made cleanup a
    // split member. OB-2041's `ports` reads ss/ufw/route here and leases on the server, which one ssh hop
    // cannot do, so it is refused by name under `remote_host`.
    // OB-2071: `lease run` starts its command on this machine, so over ssh it would run on the server.
    expect(Object.keys(REFUSED_COMMANDS)).toEqual(["ports", "lease"]);
    expect(refusalWhy("lease", ["run", "cpu:browser", "--", "true"])).not.toBeNull();
    for (const sub of ["acquire", "release", "heartbeat", "status"]) expect(refusalWhy("lease", [sub])).toBeNull();
    for (const sub of ["drain", "cleanup", "reconcile", "list"]) {
      expect(refusalWhy("spinoff", [sub])).toBeNull();
    }
    const refused = Object.keys(HANDLERS).filter(
      (command) => planExecution({ command, args: [], flags: {}, host: "ob@server" }).mode === "refused",
    );
    expect(refused).toEqual(["ports"]);
    for (const args of [[], ["next"], ["--all"]]) {
      const plan = planExecution({ command: "ports", args, flags: {}, host: "ob@server" });
      expect(plan.mode).toBe("refused");
      expect(plan.reason).toContain("OMNISLASH_API");
    }
  });

  test("the step commands are the database half itself, so they stay REMOTE", () => {
    // `spinoff claim|stamp|land|reclaim` (191) are ordinary writes: dispatched whole, they land on the
    // server, which is exactly where they belong. Classifying them as split would send them nowhere.
    for (const args of [["claim"], ["stamp"], ["land"], ["reclaim"]]) {
      expect(planExecution({ command: "spinoff", args, flags: {}, host: "h" }).mode).toBe("remote");
    }
  });

  test("--local refuses a split command instead of quietly serving half of it", () => {
    const plan = planExecution({ command: "web", args: [], flags: { local: true }, host: "h" });
    expect(plan.mode).toBe("refused");
    expect(plan.reason).toContain("--local");
  });

  test("the loop guard: a split command that ARRIVES on the server refuses, configured host or not", () => {
    for (const host of ["ob@server", null]) {
      const plan = planExecution({ command: "web", args: [], flags: {}, host, hop: true });
      expect(plan.mode).toBe("refused");
      expect(plan.reason).toContain("OB_REMOTE_HOP=1");
    }
  });

  test("INERT: with no remote_host the classification is bypassed entirely", () => {
    for (const [command, args] of [
      ["daemon", ["install"]],
      ["web", []],
      ["spinoff", ["drain"]],
      ["spinoff", ["cleanup"]],
    ] as [string, string[]][]) {
      expect(planExecution({ command, args, flags: {}, host: null }).mode).toBe("local");
      expect(planExecution({ command, args, flags: { local: true }, host: null }).mode).toBe("local");
    }
  });
});

describe("split class: the two halves through run() (189)", () => {
  async function client(host: string, serverDbPath: string): Promise<{ dbPath: string; exec: FakeServer }> {
    const dbPath = join(clientDir(), "omnislash.sqlite");
    const db = openDb(dbPath);
    await setConfig(db, "remote_host", host);
    db.close();
    // Seed the replica off the server so the read half needs no refresh mid-test.
    const server = openDb(serverDbPath);
    await Bun.write(replicaPath(dbPath), gunzip(dumpReplicaBytes(server)));
    server.close();
    return { dbPath, exec: fakeServer(serverDbPath) };
  }

  function serverDb(): string {
    const path = freshDbPath();
    openDb(path).close();
    return path;
  }

  test("a split member with an EMPTY database half dispatches nothing at all", async () => {
    // `daemon status` reads launchd, never ctx.db. It must run HERE and leave the replica clean, since a
    // needless dirty flag costs the next read a whole refresh for a server that never moved.
    const serverPath = serverDb();
    const { dbPath, exec } = await client("ob@server", serverPath);
    const res = await runCliWith(dbPath, ["daemon", "status", "--json"], exec);
    expect(res.code).toBe(0);
    expect(exec.calls.filter((c) => c[0] !== "replica")).toEqual([]);
    expect(readMeta(dbPath).dirty).toBe(false);
  });

  test("a split sweep is NOT dispatched whole: it runs here and sends only its steps (191)", async () => {
    const serverPath = serverDb();
    const { dbPath, exec } = await client("ob@server", serverPath);
    await runCliWith(dbPath, ["spinoff", "drain", "--all", "--json"], exec);
    // whatever else it did, it never shipped the sweep itself to the server
    expect(exec.calls.filter((c) => c[0] === "spinoff" && c[1] === "drain")).toEqual([]);
  });
});

describe("split class: inert with no remote_host (189)", () => {
  test("`ob spinoff list` and `ob daemon status` behave exactly as before", async () => {
    const dbPath = freshDbPath();
    const spinoffs = await runCli(dbPath, ["spinoff", "list", "--json"]);
    expect(spinoffs.code).toBe(0);
    expect(JSON.parse(spinoffs.out)).toEqual([]);
    expect(spinoffs.err).toBe("");

    const daemon = await runCli(dbPath, ["daemon", "status", "--json"]);
    expect(daemon.code).toBe(0);
    expect((JSON.parse(daemon.out) as { action: string }).action).toBe("status");
    expect(daemon.err).toBe("");
    // nothing about the replica plumbing is touched with no host configured
    expect(existsSync(replicaPath(dbPath))).toBe(false);
  });

});

describe("split class: agent register --session (189)", () => {
  test("the DB half of an architect launch is expressible as a real ob command", async () => {
    // Without --session the server-side row carries no session id, and #126's whole point is that the tab
    // can be resumed. The flag exists so the split's database half loses nothing.
    const dbPath = freshDbPath();
    const res = await runCli(dbPath, [
      "agent",
      "register",
      "--id",
      "architect-acme",
      "--status",
      "planning",
      "--launcher",
      "t3",
      "--session",
      "sess-abc",
      "--no-lease",
      "--json",
    ]);
    expect(res.code).toBe(0);
    expect((JSON.parse(res.out) as { session_id: string }).session_id).toBe("sess-abc");

    // a re-register without it preserves the stored id (the heartbeat form)
    const again = await runCli(dbPath, ["agent", "register", "--id", "architect-acme", "--status", "working", "--no-lease", "--json"]);
    expect(again.code).toBe(0);
    expect((JSON.parse(again.out) as { session_id: string }).session_id).toBe("sess-abc");
  });
});

describe("split class: the docs say what the code does (189)", () => {
  test("the README describes the class and no longer records the gap as open", () => {
    const readme = cliDocs();
    expect(readme).not.toContain("Known gap");
    expect(readme).toContain("local half");
  });
});
