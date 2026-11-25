// OS-222: `ob db clone` refuses bad targets and roles before anything runs, installs the clone script only when it
// is missing or stale, refuses an unreachable Proxmox host by name, and ends with the secret's NAME, never a value.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  cloneProfilePath,
  cloneRunInner,
  cloneTargetRefusal,
  containerArgv,
  dbClone,
  grantRoleRefusal,
  parseCloneProfile,
  type CloneDeps,
  type CloneProfile,
} from "../src/commands/db-clone.ts";
import { planExecution } from "../src/remote.ts";

const PROFILE_JSON = JSON.stringify({
  script: "bin/clone.sh",
  installPath: "/usr/local/lib/pg/clone.sh",
  container: 77,
  ssh: ["-i", "~/.ssh/key", "root@host.test"],
  liveDb: "live",
  protect: ["shared_dev"],
  target: "mine",
  grantRole: "me_test",
  urlSecret: "pg-test-url",
});

const SCRIPT = "#!/bin/sh\necho clone\n";
const SCRIPT_SUM = new Bun.CryptoHasher("sha256").update(SCRIPT).digest("hex");

function profile(): CloneProfile {
  return parseCloneProfile(PROFILE_JSON, "/cfg/db-clone.json", "/repo/ops");
}

interface Fake extends CloneDeps {
  captured: { argv: string[]; stdin?: string }[];
  streamed: { argv: string[]; toStderr: boolean }[];
  logs: string[];
}

function fake(opts: { pct?: boolean; remoteSum?: string; checkCode?: number; checkErr?: string; runCode?: number; profile?: string | null } = {}): Fake {
  const f: Fake = {
    env: { OB_DB_CLONE_FILE: "/cfg/db-clone.json" },
    captured: [],
    streamed: [],
    logs: [],
    readFile: (p) => {
      if (p === "/cfg/db-clone.json") return opts.profile === undefined ? PROFILE_JSON : opts.profile;
      if (p === "/repo/ops/bin/clone.sh") return SCRIPT;
      return null;
    },
    realDir: () => "/repo/ops",
    hasPct: () => opts.pct ?? false,
    capture(argv, stdin) {
      f.captured.push({ argv, stdin: stdin ? new TextDecoder().decode(stdin) : undefined });
      if (argv.join(" ").includes("sha256sum")) {
        const sum = opts.remoteSum ?? "";
        return { code: opts.checkCode ?? 0, stdout: sum ? `${sum}  /usr/local/lib/pg/clone.sh\n` : "", stderr: opts.checkErr ?? "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    stream(argv, toStderr) {
      f.streamed.push({ argv, toStderr });
      return opts.runCode ?? 0;
    },
    log: (line) => {
      f.logs.push(line);
    },
  };
  return f;
}

let out: string[] = [];
let spy: ReturnType<typeof spyOn>;
beforeEach(() => {
  out = [];
  spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    out.push(a.map(String).join(" "));
  });
});
afterEach(() => spy.mockRestore());

const run = (flags: Record<string, unknown>, deps: CloneDeps, mode: "human" | "json" = "human", args = ["clone"]) =>
  dbClone({ mode: mode as never, flags: flags as never, args }, deps);

describe("the clone profile", () => {
  test("OB_DB_CLONE_FILE wins, else XDG_CONFIG_HOME, else ~/.config", () => {
    expect(cloneProfilePath({ OB_DB_CLONE_FILE: "/x/p.json" })).toBe("/x/p.json");
    expect(cloneProfilePath({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/ob/db-clone.json");
    expect(cloneProfilePath({ HOME: "/home/u" })).toBe("/home/u/.config/ob/db-clone.json");
  });

  test("a relative script resolves against the profile's real directory; defaults fill in", () => {
    const p = profile();
    expect(p.script).toBe("/repo/ops/bin/clone.sh");
    expect(p.container).toBe("77");
    expect(p.runAs).toBe("postgres");
    expect(p.ssh[0]).toBe("-i");
    expect(p.ssh[1]).not.toContain("~");
  });

  test.each([
    ["not json", "{", /not valid JSON/],
    ["no container", JSON.stringify({ ...JSON.parse(PROFILE_JSON), container: "ct" }), /container/],
    ["relative installPath", JSON.stringify({ ...JSON.parse(PROFILE_JSON), installPath: "lib/x.sh" }), /absolute/],
    ["bad liveDb", JSON.stringify({ ...JSON.parse(PROFILE_JSON), liveDb: "Live;" }), /liveDb/],
  ])("refuses a profile with %s", (_name, text, re) => {
    expect(() => parseCloneProfile(text, "/cfg/p.json", "/cfg")).toThrow(re);
  });
});

describe("target and role refusals", () => {
  const p = { liveDb: "live", protect: ["shared_dev"] };
  test.each([
    ["live", /live database/],
    ["shared_dev", /protected/],
    ["postgres", /reserved/],
    ["template1", /reserved/],
    ["mine_incoming", /scratch name/],
    ["mine_old", /scratch name/],
    ["mine_restore_check", /scratch name/],
    ["a".repeat(55), /too long/],
    ["Bad;Name", /not a postgres identifier/],
  ])("refuses target %s", (t, re) => {
    expect(cloneTargetRefusal(t, p)).toMatch(re);
  });
  test("accepts an ordinary target, and the longest one", () => {
    expect(cloneTargetRefusal("mine", p)).toBeNull();
    expect(cloneTargetRefusal("a".repeat(54), p)).toBeNull();
  });

  test.each([["postgres"], ["public"], ["pg_read_all_data"], ["Bad;Role"]])("refuses grant role %s", (r) => {
    expect(grantRoleRefusal(r)).not.toBeNull();
  });
  test("accepts an ordinary role", () => expect(grantRoleRefusal("me_test")).toBeNull());

  test("the command refuses before it touches the container", async () => {
    for (const flags of [{ target: "live" }, { target: "shared_dev" }, { "grant-role": "postgres" }, { "grant-role": "" }, { "grant-role": "me_test", "no-grant": true }]) {
      const f = fake();
      await expect(run(flags, f)).rejects.toThrow(/refusing|not both/);
      expect(f.captured).toEqual([]);
      expect(f.streamed).toEqual([]);
    }
  });

  test("extra arguments are refused", async () => {
    await expect(run({}, fake(), "human", ["clone", "mine"])).rejects.toThrow(/no arguments/);
  });

  test("no pct and no ssh words in the profile is refused as a profile problem", async () => {
    const noSsh = JSON.stringify({ ...JSON.parse(PROFILE_JSON), ssh: undefined });
    const f = fake({ profile: noSsh });
    await expect(run({}, f)).rejects.toThrow(/no pct and the profile has no "ssh"/);
    expect(f.captured).toEqual([]);
  });

  test("a missing profile is refused by its path", async () => {
    await expect(run({}, fake({ profile: null }))).rejects.toThrow(/no clone profile at \/cfg\/db-clone.json/);
  });
});

describe("reaching the container", () => {
  test("pct on this machine runs pct exec directly", () => {
    expect(containerArgv(profile(), ["true"], true)).toEqual(["pct", "exec", "77", "--", "true"]);
  });

  test("otherwise ssh to the Proxmox host with the profile's words, the remote command as one quoted word", () => {
    const argv = containerArgv(profile(), cloneRunInner(profile(), "mine", "me_test"), false);
    expect(argv.slice(0, 5)).toEqual(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]);
    expect(argv).toContain("root@host.test");
    const remote = argv.at(-1)!;
    expect(remote).toStartWith("pct exec 77 -- su - postgres -c ");
    expect(remote).toContain("OBPG_DB=live");
    expect(remote).toContain("OBPG_DEV_DB=mine");
    expect(remote).toContain("OBPG_GRANT_ROLE=me_test");
  });

});

describe("dbClone", () => {
  test("dry run prints the plan and runs nothing", async () => {
    const f = fake();
    await run({ "dry-run": true }, f);
    expect(f.captured).toEqual([]);
    expect(f.streamed).toEqual([]);
    expect(out.join("\n")).toContain("would refresh mine from live");
    expect(out.join("\n")).toContain("granting me_test");
  });

  test("a missing script is installed, then the clone runs and the hint names the secret", async () => {
    const f = fake();
    await run({}, f);
    expect(f.captured).toHaveLength(2);
    expect(f.captured[1]!.stdin).toBe(SCRIPT);
    expect(f.captured[1]!.argv.at(-1)).toContain("cat >");
    expect(f.logs.some((l) => l.startsWith("installing"))).toBe(true);
    expect(f.streamed).toHaveLength(1);
    expect(f.streamed[0]!.toStderr).toBe(false);
    expect(out.join("\n")).toBe("done: mine refreshed from live; me_test can read and write it\nconnect: ob secret get pg-test-url");
  });

  test("a stale script is updated", async () => {
    const f = fake({ remoteSum: "0".repeat(64) });
    await run({}, f);
    expect(f.logs.some((l) => l.startsWith("updating"))).toBe(true);
    expect(f.captured).toHaveLength(2);
  });

  test("an up-to-date script is not reinstalled", async () => {
    const f = fake({ remoteSum: SCRIPT_SUM });
    await run({}, f);
    expect(f.captured).toHaveLength(1);
    expect(f.logs.some((l) => l.includes("up to date"))).toBe(true);
  });

  test("--target and --no-grant override the profile", async () => {
    const f = fake({ remoteSum: SCRIPT_SUM });
    await run({ target: "other", "no-grant": true }, f);
    const remote = f.streamed[0]!.argv.at(-1)!;
    expect(remote).toContain("OBPG_DEV_DB=other");
    expect(remote).not.toContain("OBPG_GRANT_ROLE");
    expect(out[0]).toBe("done: other refreshed from live\nconnect: ob secret get pg-test-url");
  });

  test("an unreachable Proxmox host is refused by name, before any install or run", async () => {
    const f = fake({ checkCode: 255, checkErr: "ssh: connect to host host.test port 22: No route to host" });
    await expect(run({}, f)).rejects.toThrow(/cannot \(ssh: connect.*not run through the ob API/s);
    expect(f.captured).toHaveLength(1);
    expect(f.streamed).toEqual([]);
  });

  test("a failed clone script is an error that says the copy is as it was", async () => {
    const f = fake({ remoteSum: SCRIPT_SUM, runCode: 1 });
    await expect(run({}, f)).rejects.toThrow(/clone script failed \(exit 1\).*mine is as it was/);
    expect(out).toEqual([]);
  });

  test("--json streams the script to stderr and prints one object", async () => {
    const f = fake({ remoteSum: SCRIPT_SUM });
    await run({}, f, "json");
    expect(f.streamed[0]!.toStderr).toBe(true);
    expect(JSON.parse(out.join("\n"))).toEqual({ target: "mine", grantRole: "me_test", liveDb: "live", installed: false, hint: "ob secret get pg-test-url" });
  });
});

describe("routing", () => {
  test("db clone opens no tracker", () => {
    const plan = planExecution({ command: "db", args: ["clone"], flags: {}, host: "pve.test" });
    expect(plan.mode).toBe("nodb");
  });
});
