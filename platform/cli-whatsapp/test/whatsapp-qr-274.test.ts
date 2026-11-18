import { describe, expect, test } from "bun:test";
import { freshDb } from "../../../apps/cli/test/helpers.ts";
import { freshPgStore } from "../../../apps/cli/test/pg/store.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";

const PG_BUDGET = spawnBudget(2);
import { QR_LIVE_SECONDS, beginPairing, readWhatsappQr, whatsappQrPath, type QrFileReader } from "../src/whatsapp/qr.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";
import { CREDENTIALS, credentialInventory, runCredentialCheck, type Probes } from "../../../apps/cli/src/credentials.ts";
import { inMemoryMasterKey } from "../../../apps/cli/src/secrets.ts";
import type { BridgeDeps } from "../src/whatsapp/bridge.ts";

// ob 274. Pairing WhatsApp meant tailing the bridge log for an ASCII QR that rotates every ~20 seconds,
// from a terminal on the box. These tests hold two lines above everything else:
//
//   1. The reader NEVER guesses. Six distinct states, and the three that are not a scannable code
//      ("nothing was ever emitted", "the window closed", "the file is unreadable") stay distinct, because
//      the fix differs for each and collapsing them is how a page starts lying.
//   2. Freshness is part of the answer. A code past one rotation is `expired`, never quietly served as
//      though the phone would take it.
//
// Everything is on the injected reader + clock: no test here reads a real bridge store.

/** The payload a real emit carries — long, opaque, and unmistakable if it turns up somewhere it must not. */
const PAYLOAD = "2@aBcDeF0123456789/qRsTuVwXyZ+abcdef==,ghIJklMNopQRstUV/wxyz0123456789==,AbCdEf01==,1";

const NOW = Date.parse("2026-08-17T12:00:00.000Z");

/** A reader over one in-memory file. `null` content means the file is not there. */
function reader(content: string | null, mode: number | null = 0o600): QrFileReader {
  return {
    exists: () => content !== null,
    read: () => {
      if (content === null) throw new Error("ENOENT");
      return content;
    },
    mode: () => mode,
  };
}

function file(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

function agoIso(seconds: number): string {
  return new Date(NOW - seconds * 1000).toISOString();
}

describe("where the QR file lives (274)", () => {
  test("derives the qr.json sibling of the bridge's messages.db", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    try {
      expect(await whatsappQrPath(db)).toEndWith("/whatsapp-bridge/store/qr.json");
    } finally {
      await lease.release();
    }
  }, PG_BUDGET);

  test("an explicit whatsapp_qr_path wins, and ~ is expanded", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    try {
      await setConfig(db, "whatsapp_qr_path", "~/somewhere/else/qr.json");
      const path = await whatsappQrPath(db);
      expect(path).toEndWith("/somewhere/else/qr.json");
      expect(path).not.toStartWith("~");
    } finally {
      await lease.release();
    }
  });
});

describe("reading the QR file (274)", () => {
  test("no file is `unset` — not an error, and it says why it might be absent", async () => {
    const qr = readWhatsappQr("/nowhere/qr.json", { reader: reader(null), now: NOW });
    expect(qr.state).toBe("unset");
    expect(qr.code).toBeNull();
    expect(qr.detail).toContain("/nowhere/qr.json");
    // The reader must offer the second explanation too, or an un-patched bridge reads as a linked session.
    expect(qr.detail).toContain("patch");
  }, PG_BUDGET);

  test("a fresh code is `live` and carries the payload plus its age", async () => {
    const qr = readWhatsappQr("/s/qr.json", {
      reader: reader(file({ event: "code", code: PAYLOAD, emitted_at: agoIso(3) })),
      now: NOW,
    });
    expect(qr.state).toBe("live");
    expect(qr.code).toBe(PAYLOAD);
    expect(qr.age_s).toBe(3);
    expect(qr.emitted_at).toBe(agoIso(3));
  }, PG_BUDGET);

  test("a code past one rotation is `expired`, and says the phone will refuse it", async () => {
    const qr = readWhatsappQr("/s/qr.json", {
      reader: reader(file({ event: "code", code: PAYLOAD, emitted_at: agoIso(QR_LIVE_SECONDS + 1) })),
      now: NOW,
    });
    expect(qr.state).toBe("expired");
    expect(qr.detail).toContain("refuse");
    // Still returned: the caller decides whether to grey it out, and a card that says "expired" beside
    // nothing at all is worse than one that shows the stale code it is talking about.
    expect(qr.code).toBe(PAYLOAD);
  }, PG_BUDGET);

  test("exactly on the boundary is still live; one second past it is not", async () => {
    const at = (age: number) =>
      readWhatsappQr("/s/qr.json", {
        reader: reader(file({ event: "code", code: PAYLOAD, emitted_at: agoIso(age) })),
        now: NOW,
      }).state;
    expect(at(QR_LIVE_SECONDS)).toBe("live");
    expect(at(QR_LIVE_SECONDS + 1)).toBe("expired");
  }, PG_BUDGET);

  // The window is NOT one number. A real pairing attempt was watched: the first code was good for 60s,
  // later ones for ~20s. whatsmeow tells the bridge which, the bridge records it, and the reader uses it —
  // otherwise a 30s guess greys out a code with half its life left, on the one panel whose whole job is
  // to be trusted about freshness.
  test("whatsmeow's own timeout_s decides the window, not a hard-coded guess", async () => {
    const at = (age: number, timeout_s: number) =>
      readWhatsappQr("/s/qr.json", {
        reader: reader(file({ event: "code", code: PAYLOAD, timeout_s, emitted_at: agoIso(age) })),
        now: NOW,
      });
    // 45s old and good for 60s: live, and the detail says both numbers.
    const long = at(45, 60);
    expect(long.state).toBe("live");
    expect(long.detail).toContain("45s ago");
    expect(long.detail).toContain("good for 60s");
    // The same 45s against a 20s code is expired, and says what it was good for.
    const short = at(45, 20);
    expect(short.state).toBe("expired");
    expect(short.detail).toContain("only good for 20s");
  }, PG_BUDGET);

  test("an implausible or missing timeout_s falls back to the short window, never a long one", async () => {
    const at = (timeout_s: unknown) =>
      readWhatsappQr("/s/qr.json", {
        reader: reader(JSON.stringify({ event: "code", code: PAYLOAD, timeout_s, emitted_at: agoIso(25) })),
        now: NOW,
      }).state;
    // 25s old: past the 20s fallback, so every one of these must read expired rather than trust the file.
    for (const bad of [0, -30, 99_999, "60", null, undefined, Number.NaN]) {
      expect(at(bad)).toBe("expired");
    }
    // And the same age against a real 60s window is live, proving the fallback is not just always-expired.
    expect(at(60)).toBe("live");
  }, PG_BUDGET);

  test("a code with no readable stamp is `expired`, because unknown age is not `live`", async () => {
    const qr = readWhatsappQr("/s/qr.json", {
      reader: reader(file({ event: "code", code: PAYLOAD, emitted_at: "not a date" })),
      now: NOW,
    });
    expect(qr.state).toBe("expired");
    expect(qr.age_s).toBeNull();
    expect(qr.detail).toContain("emitted_at");
  }, PG_BUDGET);

  test("a successful scan is `paired`, with no code to render", async () => {
    const qr = readWhatsappQr("/s/qr.json", {
      reader: reader(file({ event: "success", emitted_at: agoIso(10) })),
      now: NOW,
    });
    expect(qr.state).toBe("paired");
    expect(qr.code).toBeNull();
  }, PG_BUDGET);

  test("a closed window is `timeout` and names the command that reopens it", async () => {
    const qr = readWhatsappQr("/s/qr.json", {
      reader: reader(file({ event: "timeout", emitted_at: agoIso(90) })),
      now: NOW,
    });
    expect(qr.state).toBe("timeout");
    expect(qr.code).toBeNull();
    expect(qr.detail).toContain("ob whatsapp bridge start");
  }, PG_BUDGET);

  test("a half-written file is `unreadable`, and its body is never quoted back", async () => {
    const half = `{"event":"code","code":"${PAYLOAD.slice(0, 20)}`;
    const qr = readWhatsappQr("/s/qr.json", { reader: reader(half), now: NOW });
    expect(qr.state).toBe("unreadable");
    expect(qr.code).toBeNull();
    // A partial file can hold part of a pairing secret, so the detail must not echo what it read.
    expect(qr.detail).not.toContain(PAYLOAD.slice(0, 20));
  }, PG_BUDGET);

  test("a read that throws is `unreadable`, never `unset`", async () => {
    const throwing: QrFileReader = { exists: () => true, read: () => { throw new Error("EACCES"); }, mode: () => 0o600 };
    const qr = readWhatsappQr("/s/qr.json", { reader: throwing, now: NOW });
    expect(qr.state).toBe("unreadable");
    expect(qr.detail).toContain("EACCES");
  }, PG_BUDGET);

  test("a code event with no code is `unreadable`, not an empty QR", async () => {
    const qr = readWhatsappQr("/s/qr.json", {
      reader: reader(file({ event: "code", emitted_at: agoIso(1) })),
      now: NOW,
    });
    expect(qr.state).toBe("unreadable");
  }, PG_BUDGET);

  test("loose permissions are flagged: the file holds a pairing secret", async () => {
    const args = { reader: reader(file({ event: "code", code: PAYLOAD, emitted_at: agoIso(1) }), 0o644), now: NOW };
    expect(readWhatsappQr("/s/qr.json", args).insecure_mode).toBe(true);
    const tight = { reader: reader(file({ event: "code", code: PAYLOAD, emitted_at: agoIso(1) }), 0o600), now: NOW };
    expect(readWhatsappQr("/s/qr.json", tight).insecure_mode).toBe(false);
  }, PG_BUDGET);

  test("a future stamp reads as age 0 rather than a negative age", async () => {
    const qr = readWhatsappQr("/s/qr.json", {
      reader: reader(file({ event: "code", code: PAYLOAD, emitted_at: agoIso(-5) })),
      now: NOW,
    });
    expect(qr.age_s).toBe(0);
    expect(qr.state).toBe("live");
  });
});

// ── the credential row (274) ──────────────────────────────────────────────────────────────────────
// The tokens page listed google, linear, github, ha, cloudflare, master-key and whatsapp,
// but not the one credential that expires on its own every ~20 days.

function probes(over: Partial<Probes> = {}): Probes {
  return {
    fileState: () => ({ exists: false, bytes: 0, mode: null }),
    keychainItem: () => false,
    onPath: () => false,
    env: () => undefined,
    ...over,
  };
}

/** Bridge seams that answer for a machine with no bridge at all, unless a test says otherwise. */
function bridgeDeps(over: BridgeDeps = {}): BridgeDeps {
  return {
    readPidfile: () => null,
    isAlive: () => false,
    listenerPid: () => null,
    execPathOf: () => null,
    binExists: () => true,
    readLogTail: () => null,
    lastMessageAt: () => null,
    pairedDeviceCount: () => null,
    readToken: () => "token",
    fetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    ...over,
  };
}

describe("WhatsApp is on the credential list (274)", () => {
  test("the session is an inventory row, refreshed by a QR rather than a paste", async () => {
    const spec = CREDENTIALS.find((c) => c.name === "whatsapp");
    expect(spec).toBeDefined();
    expect(spec!.refresh).toBe("qr");
    // Not `writable`: there is no value to type in, and a paste box on this row would be a lie.
    const lease = await freshPgStore();
    const db = lease.store;
    try {
      const row = (await credentialInventory(db, probes())).find((c) => c.name === "whatsapp")!;
      expect(row.writable).toBe(false);
      expect(row.checkable).toBe(true);
    } finally {
      await lease.release();
    }
  }, PG_BUDGET);

  test("no pairing store reads as never linked", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    try {
      const row = (await credentialInventory(db, probes())).find((c) => c.name === "whatsapp")!;
      expect(row.present).toBe(false);
      expect(row.presence_detail).toContain("never linked");
    } finally {
      await lease.release();
    }
  }, PG_BUDGET);

  test("a pairing store present says so, and refuses to call it proof the session works", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    try {
      const seen: string[] = [];
      const row = (await credentialInventory(
        db,
        probes({
          fileState: (path) => {
            seen.push(path);
            return { exists: true, bytes: 40_960, mode: 0o600 };
          },
        }),
      )).find((c) => c.name === "whatsapp")!;
      expect(row.present).toBe(true);
      expect(row.presence_detail).toContain("cannot prove the pairing still works");
      // Read off the bridge's own pairing store, not messages.db.
      expect(seen.some((p) => p.endsWith("/whatsapp.db"))).toBe(true);
    } finally {
      await lease.release();
    }
  }, PG_BUDGET);

  test("a bridge that is down fails the check and says to start it", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    try {
      const row = await runCredentialCheck(db, "whatsapp", {
        masterKey: inMemoryMasterKey(),
        bridgeDeps: bridgeDeps(),
      });
      expect(row.ok).toBe(false);
      expect(row.detail).toContain("DOWN");
    } finally {
      await lease.release();
    }
  }, PG_BUDGET);

  test("a running bridge whose log says logged-out FAILS, however healthy the socket looks", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    try {
      const row = await runCredentialCheck(db, "whatsapp", {
        masterKey: inMemoryMasterKey(),
        bridgeDeps: bridgeDeps({
          readPidfile: () => 4242,
          isAlive: () => true,
          readLogTail: () => "something\nDevice logged out, please scan QR code to log in again\n",
          fetch: (async () => new Response(JSON.stringify({ connected: true, status: "ok" }))) as unknown as typeof fetch,
        }),
      });
      expect(row.ok).toBe(false);
      expect(row.detail).toContain("NOT AUTHENTICATED");
    } finally {
      await lease.release();
    }
  }, PG_BUDGET);

  test("a connected bridge with a clean log passes", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    try {
      const row = await runCredentialCheck(db, "whatsapp", {
        masterKey: inMemoryMasterKey(),
        bridgeDeps: bridgeDeps({
          readPidfile: () => 4242,
          isAlive: () => true,
          readLogTail: () => "Successfully logged in\n",
          fetch: (async () => new Response(JSON.stringify({ connected: true, status: "ok" }))) as unknown as typeof fetch,
        }),
      });
      expect(row.ok).toBe(true);
      expect(row.detail).toContain("healthy");
    } finally {
      await lease.release();
    }
  }, PG_BUDGET);

  test("the check reaches loopback only — it never leaves the machine", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    try {
      const seen: string[] = [];
      await runCredentialCheck(db, "whatsapp", {
        masterKey: inMemoryMasterKey(),
        bridgeDeps: bridgeDeps({
          readPidfile: () => 4242,
          isAlive: () => true,
          fetch: (async (input: string | URL | Request) => {
            seen.push(String(input));
            return new Response(JSON.stringify({ connected: true }));
          }) as unknown as typeof fetch,
        }),
      });
      expect(seen.length).toBe(1);
      expect(seen[0]).toStartWith("http://127.0.0.1:");
    } finally {
      await lease.release();
    }
  });
});

// ── the button's guards (274 follow-up) ───────────────────────────────────────────────────────────
// The panel was display-only, so nothing on the page could CAUSE a QR. `beginPairing` is the one action
// that closes that, and what these tests hold is everything it REFUSES: a web button must never restart a
// working session, and must never move the file that holds one.

describe("opening the pairing window (274)", () => {
  test("a DOWN bridge is started: that is the one step that makes whatsmeow emit a code", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    try {
      const spawned: string[][] = [];
      const res = await beginPairing(db, {
        bridgeDeps: bridgeDeps({
          spawn: (cmd) => {
            spawned.push(cmd);
            return 9001;
          },
          writePidfile: () => {},
        }),
      });
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("expected the window to open");
      expect(res.started).toBe(true);
      expect(res.pid).toBe(9001);
      expect(spawned.length).toBe(1);
      // Says what happens if the store still holds a good session, rather than promising a QR either way.
      expect(res.note).toContain("reconnect");
    } finally {
      await lease.release();
    }
  }, PG_BUDGET);

  test("a HEALTHY bridge is refused and left alone: a restart yields no QR and costs ingestion", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    try {
      const spawned: string[][] = [];
      const res = await beginPairing(db, {
        bridgeDeps: bridgeDeps({
          readPidfile: () => 4242,
          isAlive: () => true,
          readLogTail: () => "Successfully logged in\n",
          fetch: (async () => new Response(JSON.stringify({ connected: true }))) as unknown as typeof fetch,
          spawn: (cmd) => {
            spawned.push(cmd);
            return 1;
          },
        }),
      });
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("expected a refusal");
      expect(res.reason).toContain("nothing");
      expect(res.reason).toContain("would not produce a QR");
      // The point of the guard: nothing was spawned, nothing was signalled.
      expect(spawned.length).toBe(0);
    } finally {
      await lease.release();
    }
  }, PG_BUDGET);

  // Found by pressing it twice for real: the bridge was up and ACTIVELY emitting, and the refusal told the
  // reader that starting again changes nothing and their pairing store needed moving aside — nonsense said
  // over a live QR to somebody holding a phone. "Up but not authenticated" is three different situations.
  test("a bridge already emitting says SCAN THAT, not 'move your pairing store aside'", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    try {
      const res = await beginPairing(db, {
        bridgeDeps: bridgeDeps({
          readPidfile: () => 4242,
          isAlive: () => true,
          readLogTail: () => "Scan this QR code with your WhatsApp app\n",
          fetch: (async () => new Response(JSON.stringify({ connected: true }))) as unknown as typeof fetch,
        }),
      });
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("expected a refusal");
      expect(res.reason).toContain("waiting to be paired");
      expect(res.reason).toContain("scan that");
      // The destructive advice belongs to the dead-session case only.
      expect(res.reason).not.toContain("moves the file");
    } finally {
      await lease.release();
    }
  }, PG_BUDGET);

  test("a FOREIGN process on the port refuses the window, naming what holds it (1936)", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    try {
      // A stranger that answers connected:true used to read as our healthy bridge, so the window was
      // refused with "already up and connected". It is not ours at all, and pairing must say so - as a
      // REASON the panel can render, not a throw.
      const res = await beginPairing(db, {
        bridgeDeps: bridgeDeps({
          listenerPid: () => 9999,
          execPathOf: () => "/usr/local/bin/some-other-server",
          fetch: (async () =>
            new Response(JSON.stringify({ connected: true }))) as unknown as typeof fetch,
        }),
      });
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("expected a refusal");
      expect(res.reason).toMatch(/port \d+ is already in use by pid 9999/);
      expect(res.reason).toContain("not our bridge");
    } finally {
      await lease.release();
    }
  }, PG_BUDGET);

  test("a running bridge whose state cannot be read refuses rather than guessing", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    try {
      const res = await beginPairing(db, {
        bridgeDeps: bridgeDeps({
          readPidfile: () => 4242,
          isAlive: () => true,
          readLogTail: () => null,
          fetch: (async () => new Response("not json", { status: 500 })) as unknown as typeof fetch,
        }),
      });
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("expected a refusal");
      expect(res.reason).toContain("could not be read");
      expect(res.reason).toContain("would be a guess");
    } finally {
      await lease.release();
    }
  }, PG_BUDGET);

  test("a running-but-dead session is refused with the bridge's OWN remedy, not a destructive fix", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    try {
      const spawned: string[][] = [];
      const res = await beginPairing(db, {
        bridgeDeps: bridgeDeps({
          readPidfile: () => 4242,
          isAlive: () => true,
          readLogTail: () => "invalid use of deleted device\n",
          fetch: (async () => new Response(JSON.stringify({ connected: true }))) as unknown as typeof fetch,
          spawn: (cmd) => {
            spawned.push(cmd);
            return 1;
          },
        }),
      });
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("expected a refusal");
      // Moving the pairing store aside is the real fix and it is destructive, so it is named, not done.
      expect(res.reason).toContain("move");
      expect(res.reason).toContain("terminal");
      expect(spawned.length).toBe(0);
    } finally {
      await lease.release();
    }
  }, PG_BUDGET);

  test("nothing in the pairing path talks to WhatsApp: the only fetch is loopback", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    try {
      const seen: string[] = [];
      await beginPairing(db, {
        bridgeDeps: bridgeDeps({
          readPidfile: () => 4242,
          isAlive: () => true,
          fetch: (async (input: string | URL | Request) => {
            seen.push(String(input));
            return new Response(JSON.stringify({ connected: true }));
          }) as unknown as typeof fetch,
        }),
      });
      expect(seen.every((u) => u.startsWith("http://127.0.0.1:"))).toBe(true);
    } finally {
      await lease.release();
    }
  });
});
