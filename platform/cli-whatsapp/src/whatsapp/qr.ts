import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { settingFor } from "../../../../apps/cli/src/settings.ts";
import type { Store } from "../../../../apps/cli/src/db/store.ts";
import { expandHome } from "../../../../apps/cli/src/net.ts";
import { bridgeConfig, bridgeStatus, startBridge, type BridgeDeps } from "./bridge.ts";
import { AppError } from "../../../../apps/cli/src/errors.ts";

// ── the pairing QR, off a file instead of off a log (274) ──────────────────────────────────────────
// Re-linking WhatsApp used to mean tailing `whatsapp-bridge.log` for an ASCII QR: only readable from a
// terminal ON the box, and the code rotates every ~20 seconds, so a screenshot is stale before it is
// shared. Generating a PNG from the log was tried and failed, and the reason matters: whatsmeow's own
// "Client/QRChannel Emitting QR code <payload>" line TRUNCATES the payload, so the log does not contain
// a scannable code at all. It has to be written from the SOURCE value, at the moment the bridge receives
// it, which is why the seam is a file the bridge writes rather than anything parsed back out of a log.
//
// The bridge's HTTP API cannot serve this either: it has no QR endpoint, and it is not listening until
// after login, which is exactly the window a pairing QR is needed in. Both processes now live on the same
// box (the API host), so a file in the bridge's own `store/` is the clean seam.
//
// The FILE is written by the Go bridge (a patch the bridge build script applies). This module is
// only ever a READER: it never writes the file, never deletes it, and never logs the payload. The
// payload is a pairing secret — whoever scans it links a
// device to the account — so it leaves here exactly once, to the caller that renders it as an image, and
// nothing on the way puts it in a log line or an error message.

/** The QR file's own shape, as the bridge writes it. `code` is present only on a "code" event. */
interface QrFile {
  event?: string;
  code?: string;
  /** whatsmeow's OWN validity window for this code, in seconds (QRChannelItem.Timeout). */
  timeout_s?: number;
  emitted_at?: string;
}

/**
 * Where the bridge writes the current QR. `whatsapp_qr_path` when set, else the `qr.json` sibling of
 * `whatsapp_db_path` — the same "derive it from the store we already know about" rule
 * `whatsapp_contacts_db_path` uses, so a store that moves does not need two settings changed.
 */
export async function whatsappQrPath(store: Store): Promise<string> {
  const configured = (await settingFor(store, "whatsapp_qr_path")).trim();
  if (configured) return expandHome(configured);
  return join(dirname(expandHome(await settingFor(store, "whatsapp_db_path"))), "qr.json");
}

/**
 * The fallback validity window, used only when the file carries no `timeout_s`.
 *
 * The real window comes from whatsmeow, which tells the bridge how long each code is good for and has
 * that recorded in the file — because it is NOT one number: watching a real pairing attempt, the first
 * code lasted 60s and the next was issued 60s later, while later ones drop to ~20s. A single hard-coded
 * guess therefore either calls a live code expired (a QR greyed out with 30 good seconds left on it) or
 * promises a dead one is scannable. So this is the floor for an old file that predates `timeout_s`, and
 * it is deliberately the SHORT end: saying "expired" about a code that still works costs a page refresh,
 * while the opposite costs a failed scan and no explanation.
 */
export const QR_LIVE_SECONDS = 20;

/** An implausible `timeout_s` is ignored rather than trusted: a window of an hour is not a pairing QR. */
const QR_TIMEOUT_MAX_SECONDS = 300;

/** The window this code is actually good for: whatsmeow's own number when the file has a sane one. */
function liveWindow(timeout: unknown): number {
  if (typeof timeout !== "number" || !Number.isFinite(timeout)) return QR_LIVE_SECONDS;
  if (timeout <= 0 || timeout > QR_TIMEOUT_MAX_SECONDS) return QR_LIVE_SECONDS;
  return Math.round(timeout);
}

/**
 * What the QR file says right now. Six answers, not two — the reason for each is that the fixes differ:
 *
 *  - `unset`      no file: the bridge has never emitted a QR here (already paired, or too old to have
 *                 the QR patch). Not an error.
 *  - `live`       a code still inside its own validity window (`timeout_s`): scan it.
 *  - `expired`    a code past that window: the bridge is no longer emitting, or it is down.
 *  - `paired`     the bridge reported the scan succeeded. Nothing to scan.
 *  - `timeout`    the pairing window closed unscanned; the bridge has to be restarted to reopen it.
 *  - `unreadable` the file is there but could not be read or parsed. Never guessed at in either
 *                 direction: an unreadable file is not evidence that no QR exists.
 */
export type QrState = "unset" | "live" | "expired" | "paired" | "timeout" | "unreadable";

export interface WhatsappQr {
  state: QrState;
  /** The raw pairing payload — ONLY on `live`. Never logged; rendered to an image and dropped. */
  code: string | null;
  /** When the bridge emitted it, as the bridge recorded it. Null when the file carries no usable stamp. */
  emitted_at: string | null;
  /** Whole seconds since `emitted_at`, or null without one. */
  age_s: number | null;
  /** What was read and what it does not prove. Safe to log: never contains the payload. */
  detail: string;
  /** True when the file is readable by anyone but its owner — it holds a pairing secret. */
  insecure_mode: boolean;
  /** The file that was read, so a reader can go and look at it. */
  path: string;
}

/** The filesystem reads this module needs, as a seam: a test never touches a real bridge store. */
export interface QrFileReader {
  exists(path: string): boolean;
  read(path: string): string;
  /** Permission bits, or null when they could not be read. */
  mode(path: string): number | null;
}

export const realQrFileReader: QrFileReader = {
  exists: (path) => existsSync(path),
  read: (path) => readFileSync(path, "utf8"),
  mode: (path) => {
    try {
      return statSync(path).mode & 0o777;
    } catch {
      return null;
    }
  },
};

function ageSeconds(emittedAt: string | null, now: number): number | null {
  if (!emittedAt) return null;
  const t = Date.parse(emittedAt);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((now - t) / 1000));
}

/**
 * Read the current pairing QR. Pure apart from the injected reader + clock, and total: every failure
 * path lands on a state with a sentence, because the tokens page has to be able to say what it found
 * rather than render an empty box.
 */
export function readWhatsappQr(
  path: string,
  opts: { reader?: QrFileReader; now?: number } = {},
): WhatsappQr {
  const reader = opts.reader ?? realQrFileReader;
  const now = opts.now ?? Date.now();
  const base = { code: null, emitted_at: null, age_s: null, insecure_mode: false, path };

  if (!reader.exists(path)) {
    return {
      ...base,
      state: "unset",
      detail:
        `no QR file at ${path}. Either the session is linked and the bridge never needed to emit one, or` +
        ` the running bridge predates the QR-file patch (rebuild it with the bridge build script)`,
    };
  }

  const mode = reader.mode(path);
  const insecure_mode = mode !== null && (mode & 0o077) !== 0;

  let raw: string;
  try {
    raw = reader.read(path);
  } catch (err) {
    return { ...base, state: "unreadable", detail: `${path} could not be read: ${(err as Error).message}` };
  }

  let parsed: QrFile;
  try {
    parsed = JSON.parse(raw) as QrFile;
  } catch {
    // Deliberately not quoting the body: a half-written file could contain part of the payload.
    return { ...base, state: "unreadable", insecure_mode, detail: `${path} is not the JSON the bridge writes` };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ...base, state: "unreadable", insecure_mode, detail: `${path} does not hold a JSON object` };
  }

  const emitted_at = typeof parsed.emitted_at === "string" && parsed.emitted_at ? parsed.emitted_at : null;
  const age_s = ageSeconds(emitted_at, now);
  const event = typeof parsed.event === "string" ? parsed.event : "";
  const stamp = emitted_at ? ` (${emitted_at})` : "";

  if (event === "success") {
    return {
      ...base,
      state: "paired",
      emitted_at,
      age_s,
      insecure_mode,
      detail: `the bridge recorded a successful scan${stamp} — there is nothing left to pair`,
    };
  }
  if (event === "timeout") {
    return {
      ...base,
      state: "timeout",
      emitted_at,
      age_s,
      insecure_mode,
      detail:
        `the bridge's pairing window closed unscanned${stamp}. It only opens on start, so restart the` +
        ` bridge (\`ob whatsapp bridge start\`) to get a fresh QR`,
    };
  }

  const code = typeof parsed.code === "string" ? parsed.code.trim() : "";
  if (!code) {
    return {
      ...base,
      state: "unreadable",
      emitted_at,
      age_s,
      insecure_mode,
      detail: `${path} carries event '${event || "(none)"}' with no code, so there is nothing to render`,
    };
  }
  if (age_s === null) {
    // No stamp means freshness cannot be judged, and a QR whose age is unknown is not one to promise is
    // scannable — but it is still the newest thing the bridge wrote, so it is offered, labelled honestly.
    return {
      ...base,
      state: "expired",
      emitted_at,
      age_s,
      code,
      insecure_mode,
      detail: `${path} carries a code with no readable emitted_at, so how old it is cannot be known`,
    };
  }
  const window_s = liveWindow(parsed.timeout_s);
  if (age_s > window_s) {
    return {
      ...base,
      state: "expired",
      emitted_at,
      age_s,
      code,
      insecure_mode,
      detail:
        `the newest code was emitted ${age_s}s ago and was only good for ${window_s}s, so the phone will` +
        ` refuse it. The bridge has stopped emitting: check that it is running and unpaired`,
    };
  }
  return {
    ...base,
    state: "live",
    emitted_at,
    age_s,
    code,
    insecure_mode,
    detail:
      `emitted ${age_s}s ago, good for ${window_s}s — scan it with WhatsApp on your phone (Settings,` +
      ` Linked devices)`,
  };
}

// ── causing a QR, not just reading one (274 follow-up) ────────────────────────────────────────────
// The panel above was display-only, and that made it unusable for the thing it exists for: with no
// qr.json there was nothing on the page to click, and the only way to make a QR appear was a terminal
// command — which is exactly the problem the ticket set out to remove.
//
// So there is one action, and it is deliberately the NARROWEST one that works: start the bridge when it
// is DOWN. whatsmeow opens its QR channel on startup when the store holds no usable device, so that
// single step is what produces a code.
//
// Everything else REFUSES, and says why, rather than doing something clever:
//
//  - A healthy session is left alone. Restarting a working bridge produces no QR at all (it just
//    reconnects) and would interrupt ingestion for nothing.
//  - A running-but-unauthenticated bridge (the "invalid use of deleted device" case) needs its pairing
//    store MOVED ASIDE before a QR can be issued. That is a destructive step on the file that holds the
//    session, and a web button is the wrong place for it, so the refusal hands back the bridge's own
//    remedy text and the human does it deliberately.
//
// No pairing happens here either way: this opens the window, and only a phone can walk through it.

/** Refused, with the reason a human needs. Never a silent no-op. */
export interface PairingRefused {
  ok: false;
  reason: string;
}

/** The pairing window is open (or was already). `started` distinguishes the two. */
export interface PairingOpened {
  ok: true;
  started: boolean;
  pid: number;
  note: string;
}

export type PairingResult = PairingOpened | PairingRefused;

/**
 * Open the pairing window by starting a DOWN bridge. Read the block comment above for what it refuses
 * and why. Local only: it spawns the bridge binary and probes loopback; it never talks to WhatsApp.
 */
export async function beginPairing(
  store: Store,
  deps: { bridgeDeps?: BridgeDeps } = {},
): Promise<PairingResult> {
  const cfg = await bridgeConfig(store);
  const bridgeDeps = deps.bridgeDeps ?? {};
  const status = await bridgeStatus(cfg, bridgeDeps);

  if (status.running) {
    if (status.health === "healthy") {
      return {
        ok: false,
        reason:
          `the bridge is already up and connected on :${cfg.port} (pid ${status.pid}), so there is nothing` +
          ` to pair. Restarting it would not produce a QR — a bridge with a working session reconnects` +
          ` instead of asking for one — and would interrupt ingestion for nothing`,
      };
    }
    // Already asking to be paired. This is NOT a problem to be fixed, and it must not be described as one:
    // the pairing window is open right now and the current code is on the page that just asked. Saying
    // "starting again changes nothing, move your pairing store aside" over a live QR would be the panel
    // talking nonsense at somebody holding a phone.
    if (status.log === "awaiting-qr") {
      return {
        ok: false,
        reason:
          `the bridge is already up on :${cfg.port} (pid ${status.pid}) and waiting to be paired — the` +
          ` current code is the one shown here, so scan that rather than starting it again. If nothing is` +
          ` shown, its window has closed: stop the bridge and start it again to reopen one`,
      };
    }
    // A refused CLIENT (405 "Client outdated", 1347) is NOT a dead session, and this is the one place
    // that would have talked somebody into throwing a working pairing away: the bridge cannot connect,
    // so it never reaches the point of asking for a QR, and re-pairing cannot change the version
    // WhatsApp accepts. The rebuild remedy is the whole answer.
    if (status.health === "unauthenticated" && status.log === "client-outdated") {
      return {
        ok: false,
        reason:
          `the bridge is running on :${cfg.port} (pid ${status.pid}) but WhatsApp refuses its client as` +
          ` outdated (405), and nothing is wrong with the stored session - so pairing again fixes` +
          ` nothing. ${status.remedy ?? "Update whatsmeow and rebuild the bridge."}`,
      };
    }
    // A dead session (deleted-device / logged-out): a QR cannot be issued until the stored device is out of
    // the way, and moving the file that holds the session is not a thing a web button should do.
    if (status.health === "unauthenticated") {
      return {
        ok: false,
        reason:
          `the bridge is running on :${cfg.port} (pid ${status.pid}) but its stored session is dead` +
          ` (${status.log}). The QR channel only opens when the bridge starts with no usable device, so` +
          ` that stored one has to go first: ${status.remedy ?? "check the bridge log"}. That step moves the` +
          ` file holding the session, so it is done deliberately from a terminal, not from here`,
      };
    }
    return {
      ok: false,
      reason:
        `the bridge is running on :${cfg.port} (pid ${status.pid}) but its state could not be read` +
        ` (${status.health}), so starting it again would be a guess. ${status.remedy ?? "Check the bridge log"}`,
    };
  }

  let started: ReturnType<typeof startBridge>;
  try {
    started = startBridge(cfg, bridgeDeps);
  } catch (err) {
    // A refused start (a foreign listener on the port, a missing binary) is a REASON, not a crash: this
    // function returns refusals so the panel can render them as text, and a thrown error reads as a
    // broken button. 1936 is the case that surfaced it: a stranger on the port is no longer `running`, so
    // pairing falls through to `start`, whose refusal names the pid and its executable.
    if (!(err instanceof AppError)) throw err;
    return { ok: false, reason: err.message };
  }
  return {
    ok: true,
    started: started.started,
    pid: started.pid,
    note: started.started
      ? `bridge started on :${cfg.port} (pid ${started.pid}). If its store holds no usable device it will` +
        ` emit a QR within a few seconds; if it still has a working session it will simply reconnect and no` +
        ` QR will appear, which is the honest answer rather than a spinner that never resolves`
      : `the bridge was already up on :${cfg.port} (pid ${started.pid})`,
  };
}
