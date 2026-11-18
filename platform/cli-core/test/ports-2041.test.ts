// OB-2041: `ob ports` states, flags, firewall check and the `next` claim. Fixtures only: no live network,
// no real ss, no sudo, no database.
import { describe, expect, test } from "bun:test";
import {
  ufwAllowLine,
  claimNext,
  compactRanges,
  formatReport,
  gather,
  isLoopbackAddress,
  mergePorts,
  parseRouteSrc,
  parseSs,
  parseUfwRules,
  runPorts,
  type PortsIo,
} from "../../../apps/cli/src/ports.ts";
import type { LeaseStatusRow } from "../../../platform/cli-coord/src/lease.ts";

const LAN = "10.0.0.0/24";
const UFW_ALLOW_LINE = ufwAllowLine(LAN);

const SS = `LISTEN 0      511        127.0.0.1:5173  0.0.0.0:* users:(("node",pid=1234,fd=20))
LISTEN 0      511          0.0.0.0:5101  0.0.0.0:* users:(("bun",pid=77,fd=9))
LISTEN 0      511             [::1]:5102     [::]:* users:(("vite",pid=88,fd=9))
LISTEN 0      4096               *:5103        *:*
LISTEN 0      4096   127.0.0.53%lo:53    0.0.0.0:*
LISTEN 0      4096         0.0.0.0:5199  0.0.0.0:*
LISTEN 0      4096         0.0.0.0:22    0.0.0.0:*
not a socket line
`;

function lease(resource: string, holder: string, expired = false): LeaseStatusRow {
  return { resource, holder, acquired_at: "2026-11-13T10:00:00.000Z", ttl_s: 1200, heartbeat_at: null, expired };
}

function io(over: Partial<PortsIo> = {}): PortsIo & { acquired: string[] } {
  const acquired: string[] = [];
  return {
    leases: async () => [],
    acquire: async (resource, holder) => {
      acquired.push(`${resource}:${holder}`);
      return { ok: true, holder };
    },
    ss: () => "",
    route: () => "1.1.1.1 via 10.0.0.1 dev enp34s0 src 10.0.0.149 uid 1000 \n    cache\n",
    ufw: () => "### tuple ### allow tcp 5100:5199 0.0.0.0/0 any 10.0.0.0/24 in comment=6f62\n",
    defaultHolder: () => "1@host",
    ...over,
    acquired,
  };
}

describe("parseSs", () => {
  test("reads address, port, pid and process; skips junk", () => {
    const l = parseSs(SS);
    expect(l.find((x) => x.port === 5173)).toEqual({ address: "127.0.0.1", port: 5173, process: "node", pid: 1234 });
    expect(l.find((x) => x.port === 5102)).toEqual({ address: "::1", port: 5102, process: "vite", pid: 88 });
    expect(l.find((x) => x.port === 5103)).toEqual({ address: "*", port: 5103 });
    expect(l.find((x) => x.port === 53)?.address).toBe("127.0.0.53%lo");
    expect(l).toHaveLength(7);
  });

  test("loopback addresses", () => {
    for (const a of ["127.0.0.1", "127.0.0.53%lo", "::1", "localhost"]) expect(isLoopbackAddress(a)).toBe(true);
    for (const a of ["0.0.0.0", "::", "*", "10.0.0.149"]) expect(isLoopbackAddress(a)).toBe(false);
  });
});

describe("parseRouteSrc", () => {
  test("takes the src of the default route", () => {
    expect(parseRouteSrc("1.1.1.1 via 10.0.0.1 dev enp34s0 src 10.0.0.149 uid 1000")).toBe("10.0.0.149");
    expect(parseRouteSrc("RTNETLINK answers: Network is unreachable")).toBeNull();
  });
  test("a VPN source address is not a LAN address, so it reads unknown", () => {
    expect(parseRouteSrc("1.1.1.1 dev tun0 src 10.8.0.2 uid 1000")).toBeNull();
  });
});

describe("parseUfwRules", () => {
  const rule = (dport: string, src: string, action = "allow", proto = "tcp") =>
    `### tuple ### ${action} ${proto} ${dport} 0.0.0.0/0 any ${src} in\n`;
  test("the whole range from the LAN is present", () => {
    expect(parseUfwRules(rule("5100:5199", "10.0.0.0/24"), LAN)).toBe("present");
    expect(parseUfwRules(rule("5000:5300", "10.0.0.0/24"), LAN)).toBe("present");
  });
  test("anything else is missing", () => {
    expect(parseUfwRules(rule("5100:5199", "10.0.0.0/25"), LAN)).toBe("missing");
    expect(parseUfwRules(rule("5100:5199", "10.0.0.119"), LAN)).toBe("missing");
    expect(parseUfwRules("### tuple ### allow tcp 5100:5199 0.0.0.0/0 any 10.0.0.0/24 out\n", LAN)).toBe("missing");
    expect(parseUfwRules(rule("5100:5199", "0.0.0.0/0"), LAN)).toBe("missing");
    expect(parseUfwRules(rule("5100:5199", "10.0.0.0/16"), LAN)).toBe("missing");
    expect(parseUfwRules(rule("5100:5150", "10.0.0.0/24"), LAN)).toBe("missing");
    expect(parseUfwRules(rule("5173", "10.0.0.0/24"), LAN)).toBe("missing");
    expect(parseUfwRules(rule("5100:5199", "10.0.0.0/24", "deny"), LAN)).toBe("missing");
    expect(parseUfwRules(rule("5100:5199", "10.0.0.0/24", "allow", "udp"), LAN)).toBe("missing");
    expect(parseUfwRules(rule("5100:5199", "10.0.0.0/24", "allow", "any"), LAN)).toBe("missing");
    // ufw evaluates in order: a deny written before the allow blocks the LAN, the other way round it does not
    expect(
      parseUfwRules(rule("5100:5199", "10.0.0.0/24", "deny") + rule("5100:5199", "10.0.0.0/24"), LAN),
    ).toBe("missing");
    for (const [dport, src, proto] of [["5150", "10.0.0.0/24", "tcp"], ["5120:5130", "0.0.0.0/0", "tcp"], ["5100:5199", "10.0.0.0/16", "any"]] as const) {
      expect(parseUfwRules(rule(dport, src, "deny", proto) + rule("5100:5199", "10.0.0.0/24"), LAN)).toBe("missing");
    }
    // a deny elsewhere (other port, other network, other destination address) does not block
    expect(
      parseUfwRules("### tuple ### deny tcp 5100:5199 172.17.0.1 any 10.0.0.0/24 in\n" + rule("5100:5199", "10.0.0.0/24"), LAN),
    ).toBe("present");
    // a rate-limit rule is an accept, not a block
    expect(parseUfwRules(rule("5100:5199", "10.0.0.0/24", "limit") + rule("5100:5199", "10.0.0.0/24"), LAN)).toBe("present");
    expect(parseUfwRules(rule("8123", "10.0.0.0/24", "deny") + rule("5100:5199", "10.0.0.0/24"), LAN)).toBe("present");
    expect(parseUfwRules(rule("5100:5199", "172.16.0.0/12", "deny") + rule("5100:5199", "10.0.0.0/24"), LAN)).toBe("present");
    expect(
      parseUfwRules(rule("5100:5199", "10.0.0.0/24") + rule("5100:5199", "10.0.0.0/24", "deny"), LAN),
    ).toBe("present");
    expect(parseUfwRules("### tuple ### allow tcp 8123 0.0.0.0/0 any 10.0.0.119 in\n", LAN)).toBe("missing");
    // a rule for one destination address, or one source port, does not open the range for the LAN
    expect(parseUfwRules("### tuple ### allow tcp 5100:5199 10.0.0.149 any 10.0.0.0/24 in\n", LAN)).toBe("missing");
    expect(parseUfwRules("### tuple ### allow tcp 5100:5199 0.0.0.0/0 4000 10.0.0.0/24 in\n", LAN)).toBe("missing");
    expect(parseUfwRules("", LAN)).toBe("missing");
  });
});

describe("mergePorts", () => {
  const rows = mergePorts({
    leases: [
      lease("port:5101", "ob-1"), // leased and listening on 0.0.0.0
      lease("port:5104", "ob-2"), // leased, not listening
      lease("port:5105", "ob-3", true), // expired: not leased
      lease("ticket:OB-9", "ob-9"), // not a port
    ],
    listeners: parseSs(SS),
    lanIp: "10.0.0.149",
  });
  const at = (p: number) => rows.find((r) => r.port === p)!;

  test("covers 5100 to 5199", () => {
    expect(rows).toHaveLength(100);
    expect(rows[0]!.port).toBe(5100);
    expect(rows[99]!.port).toBe(5199);
  });
  test("each state", () => {
    expect(at(5100).state).toBe("free");
    expect(at(5101).state).toBe("leased+listening");
    expect(at(5101).holder).toBe("ob-1");
    expect(at(5104).state).toBe("leased");
    expect(at(5105).state).toBe("free");
    expect(at(5173).state).toBe("listening");
  });
  test("loopback-only and unleased flags", () => {
    expect(at(5173).loopbackOnly).toBe(true);
    expect(at(5173).unleased).toBe(true);
    expect(at(5173).url).toBeUndefined();
    expect(at(5102).loopbackOnly).toBe(true); // ::1
    expect(at(5101).loopbackOnly).toBe(false);
    expect(at(5101).unleased).toBe(false);
    expect(at(5103).unleased).toBe(true); // `*` is reachable
    expect(at(5103).loopbackOnly).toBe(false);
  });
  test("LAN URL for reachable listeners, never localhost", () => {
    expect(at(5101).url).toBe("http://10.0.0.149:5101");
    expect(at(5199).url).toBe("http://10.0.0.149:5199");
    for (const r of rows) expect(r.url ?? "").not.toMatch(/localhost|127\.0\.0\.1/);
  });
  test("a v4 loopback plus a v6 wildcard listener is reachable", () => {
    const m = mergePorts({
      leases: [],
      listeners: [
        { address: "127.0.0.1", port: 5120 },
        { address: "::", port: 5120 },
      ],
      lanIp: "10.0.0.149",
    });
    expect(m.find((r) => r.port === 5120)!.loopbackOnly).toBe(false);
  });
  test("compactRanges", () => {
    expect(compactRanges([5100, 5101, 5102, 5104, 5106, 5107])).toBe("5100-5102, 5104, 5106-5107");
  });
});

describe("ob ports output", () => {
  test("states, flags and the LAN URL are printed; free ports collapse", async () => {
    const report = await gather(
      io({
        leases: async () => [lease("port:5101", "ob-1")],
        ss: () => SS,
      }),
    );
    const text = formatReport(report, false);
    expect(text).toContain("firewall: present");
    expect(text).toContain("5101\tleased+listening\tholder ob-1");
    expect(text).toContain("http://10.0.0.149:5101");
    expect(text).toContain("loopback only: the iPad cannot reach it, start it with --host");
    expect(text).toContain("unleased");
    expect(text).toMatch(/free \(\d+\): 5100,/);
    expect(text).not.toMatch(/localhost/);
    expect(formatReport(report, true).split("\n").filter((l) => /^51\d\d\t/.test(l))).toHaveLength(100);
  });

  test("a missing ufw rule prints the exact line and runs nothing", async () => {
    const report = await gather(io({ ufw: () => "### tuple ### allow tcp 8123 0.0.0.0/0 any 10.0.0.119 in\n" }));
    expect(report.firewall).toBe("missing");
    expect(report.firewall_fix).toBe(UFW_ALLOW_LINE);
    expect(ufwAllowLine("10.0.0.0/24")).toBe(
      "sudo ufw allow from 10.0.0.0/24 to any port 5100:5199 proto tcp comment 'ob dev ports'",
    );
    expect(formatReport(report, false)).toContain(UFW_ALLOW_LINE);
  });

  test("unreadable ufw rules read unknown and still print the line", async () => {
    const report = await gather(io({ ufw: () => null }));
    expect(report.firewall).toBe("unknown");
    expect(formatReport(report, false)).toContain(UFW_ALLOW_LINE);
  });

  test("each source degrades on its own", async () => {
    const report = await gather(
      io({
        leases: async () => {
          throw new Error("api down");
        },
        ss: () => null,
        route: () => null,
      }),
    );
    expect(report.leases).toBe("unavailable");
    expect(report.listening).toBe("unknown");
    expect(report.lan_ip).toBeNull();
    expect(report.ports.every((r) => r.state === "unknown" && !r.unleased)).toBe(true);
    const text = formatReport(report, false);
    expect(text).toContain("free: unknown for 100 ports");
    expect(text).not.toContain("5100\tunknown");
    expect(text).not.toMatch(/free \(/);
    expect(formatReport(report, true)).toContain("5100\tunknown");
    expect(text).toContain("leases: unavailable");
    expect(text).toContain("listening: unknown");
  });
});

describe("ob ports next", () => {
  test("claims the lowest port neither leased nor listening", async () => {
    const i = io({
      leases: async () => [lease("port:5100", "other"), lease("port:5101", "other2")],
      ss: () => "LISTEN 0 511 0.0.0.0:5102 0.0.0.0:* users:((\"node\",pid=1,fd=1))\n",
    });
    const claim = await claimNext(i, { holder: "x", ttlS: 100 });
    expect(claim).toEqual({ port: 5103, holder: "x", url: "http://10.0.0.149:5103" });
    expect(i.acquired).toEqual(["port:5103:x"]);
  });

  test("a leased port that is not yet listening is never handed out", async () => {
    const i = io({ leases: async () => [lease("port:5100", "other")] });
    expect((await claimNext(i, { holder: "x", ttlS: 100 })).port).toBe(5101);
  });

  test("a refused acquire (a race) tries the next candidate", async () => {
    const tried: string[] = [];
    const i = io({
      acquire: async (resource, holder) => {
        tried.push(resource);
        return resource === "port:5100" ? { ok: false, holder: "winner" } : { ok: true, holder };
      },
    });
    expect((await claimNext(i, { holder: "x", ttlS: 100 })).port).toBe(5101);
    expect(tried).toEqual(["port:5100", "port:5101"]);
  });

  test("an exhausted range is a clear error", async () => {
    const i = io({ acquire: async (_r, _h) => ({ ok: false, holder: "w" }) });
    await expect(claimNext(i, { holder: "x", ttlS: 100 })).rejects.toThrow(/no free port in 5100-5199/);
  });

  test("an unreachable lease API refuses; it does not claim blind", async () => {
    const i = io({
      leases: async () => {
        throw new Error("api down");
      },
    });
    await expect(claimNext(i, { holder: "x", ttlS: 100 })).rejects.toThrow(/needs the lease API/);
    expect(i.acquired).toEqual([]);
  });

  test("no ss: the lease alone decides", async () => {
    const i = io({ ss: () => null, leases: async () => [lease("port:5100", "other")] });
    expect((await claimNext(i, { holder: "x", ttlS: 100 })).port).toBe(5101);
  });

  test("runPorts next leaves port:<n> leased to --holder and prints port then LAN URL", async () => {
    const printed: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void printed.push(`${a.join(" ")}\n`);
    const i = io();
    try {
      await runPorts({ args: ["next"], flags: { holder: "ob-1234" }, mode: "human" }, i);
    } finally {
      console.log = orig;
    }
    expect(i.acquired).toEqual(["port:5100:ob-1234"]);
    const out = printed.join("");
    expect(out).toContain("5100\n");
    expect(out).toContain("http://10.0.0.149:5100");
  });

  test("--ticket names the holder; --quiet prints the number alone", async () => {
    const printed: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void printed.push(`${a.join(" ")}\n`);
    const i = io();
    try {
      await runPorts({ args: ["next"], flags: { ticket: "OB-2041" }, mode: "quiet" }, i);
    } finally {
      console.log = orig;
    }
    expect(i.acquired).toEqual(["port:5100:ob-2041"]);
    expect(printed.join("").trim()).toBe("5100");
  });

  test("no LAN address: no placeholder URL, only the port", async () => {
    const printed: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void printed.push(`${a.join(" ")}\n`);
    try {
      await runPorts({ args: ["next"], flags: {}, mode: "human" }, io({ route: () => null }));
      expect((await claimNext(io({ route: () => null }), { holder: "x", ttlS: 100 })).url).toBeNull();
    } finally {
      console.log = orig;
    }
    expect(printed.join("")).toBe("5100\n");
  });

  test("--ttl must be a whole number above zero", async () => {
    for (const ttl of ["1.5", "0", "-3", "abc"]) {
      await expect(runPorts({ args: ["next"], flags: { ttl }, mode: "human" }, io())).rejects.toThrow(/whole number/);
    }
  });

  test("a listener on a non-LAN address gets no URL", () => {
    const m = mergePorts({ leases: [], listeners: [{ address: "172.17.0.1", port: 5130 }], lanIp: "10.0.0.149" });
    const r = m.find((x) => x.port === 5130)!;
    expect(r.state).toBe("listening");
    expect(r.url).toBeUndefined();
    expect(r.loopbackOnly).toBe(false);
  });

  test("a bare #<n> ticket holds the port as the builder id issue-<n>", async () => {
    const i = io();
    const orig = console.log;
    console.log = () => {};
    try {
      await runPorts({ args: ["next"], flags: { ticket: "#42" }, mode: "quiet" }, i);
    } finally {
      console.log = orig;
    }
    expect(i.acquired).toEqual(["port:5100:issue-42"]);
  });

  test("an unknown subcommand is a usage error", async () => {
    await expect(runPorts({ args: ["bogus"], flags: {}, mode: "human" }, io())).rejects.toThrow(/unknown ports subcommand/);
  });
});
