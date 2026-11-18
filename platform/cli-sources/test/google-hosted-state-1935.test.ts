// OB-1935: the hosted OAuth state store prunes expired records before live ones, shares burns across
// processes through the state file under a flock, refuses an expired state without burning it, and fails
// closed (busy) when the file cannot be locked, read or saved. The expired-retry case is in google-hosted-1305.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GoogleStateBusyError,
  STATE_TTL_MS,
  createGoogleStateStore,
  stateRefusalSentence,
} from "../src/google-hosted.ts";

const URI = "https://ob.example/api/ob/google/callback";
const T0 = 1_000_000;

describe("prune order under cap pressure (OB-1935)", () => {
  test("255 expired plus a few live: no live state is dropped, even one written before the expired ones", () => {
    const states = createGoogleStateStore(STATE_TTL_MS);
    const later = T0 + STATE_TTL_MS + 1;
    // Insertion order is not issue order (another process, or a clock behind): the old prune dropped this.
    const live = [states.mint(URI, later)];
    for (let i = 0; i < 255; i++) states.mint(URI, T0);
    for (let i = 0; i < 10; i++) live.push(states.mint(URI, later));
    for (const s of live) expect(states.burn(s, later).ok).toBe(true);
  });

  test("with 256 live states, one more mint drops only the oldest", () => {
    const states = createGoogleStateStore(STATE_TTL_MS);
    const live: string[] = [];
    for (let i = 0; i < 256; i++) live.push(states.mint(URI, T0 + i));
    const newest = states.mint(URI, T0 + 256);
    const at = T0 + 300;
    expect(states.inspect(live[0], at)).toEqual({ ok: false, reason: "unknown" });
    for (const s of live.slice(1)) expect(states.inspect(s, at).ok).toBe(true);
    expect(states.burn(newest, at).ok).toBe(true);
  });
});

describe("the file store (OB-1935)", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ob1935-"));
    file = join(dir, "google-oauth-state.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a burn in store A reads as reused in store B on the same file", () => {
    const a = createGoogleStateStore(STATE_TTL_MS, file);
    const b = createGoogleStateStore(STATE_TTL_MS, file);
    const s = a.mint(URI, T0);
    expect(a.burn(s, T0 + 1).ok).toBe(true);
    expect(b.burn(s, T0 + 2)).toEqual({ ok: false, reason: "reused" });
  });

  test("a lock that cannot be taken: burn is busy and leaves the state unburned, mint throws", () => {
    const store = createGoogleStateStore(STATE_TTL_MS, file);
    const s = store.mint(URI, T0);
    const locked = createGoogleStateStore(STATE_TTL_MS, file, { flock: () => -1, waitMs: 0 });
    expect(locked.burn(s, T0 + 1)).toEqual({ ok: false, reason: "busy" });
    expect(() => locked.mint(URI, T0 + 1)).toThrow(GoogleStateBusyError);
    expect(() => locked.mint(URI, T0 + 1)).toThrow(stateRefusalSentence("busy"));
    // Still unburned: the real store burns it.
    expect(store.burn(s, T0 + 2).ok).toBe(true);
  });

  test("no flock at all is busy, never an unlocked write", () => {
    const store = createGoogleStateStore(STATE_TTL_MS, file, { flock: null });
    expect(() => store.mint(URI, T0)).toThrow(GoogleStateBusyError);
    expect(store.burn("deadbeef", T0)).toEqual({ ok: false, reason: "busy" });
  });

  test("a corrupt file: burn is busy, mint throws, and the file is left as it was", () => {
    writeFileSync(file, "{not json");
    const store = createGoogleStateStore(STATE_TTL_MS, file);
    expect(store.burn("deadbeef", T0)).toEqual({ ok: false, reason: "busy" });
    expect(() => store.mint(URI, T0)).toThrow(GoogleStateBusyError);
    expect(store.inspect("deadbeef", T0)).toEqual({ ok: false, reason: "busy" });
    expect(readFileSync(file, "utf8")).toBe("{not json");
  });

  test("a malformed record makes the file unreadable: busy, and the file is left as it was", () => {
    const raw = JSON.stringify({ s: { issuedAt: 1 } });
    writeFileSync(file, raw);
    const store = createGoogleStateStore(STATE_TTL_MS, file);
    expect(store.burn("s", T0)).toEqual({ ok: false, reason: "busy" });
    expect(readFileSync(file, "utf8")).toBe(raw);
  });

  test("a missing file is an empty set", () => {
    const store = createGoogleStateStore(STATE_TTL_MS, file);
    expect(store.burn("deadbeef", T0)).toEqual({ ok: false, reason: "unknown" });
    const s = store.mint(URI, T0);
    expect(JSON.parse(readFileSync(file, "utf8"))[s]).toEqual({ issuedAt: T0, redirectUri: URI, burned: false });
  });

  test("a save that fails: burn is busy and does not report ok", () => {
    const store = createGoogleStateStore(STATE_TTL_MS, file);
    const s = store.mint(URI, T0);
    // A directory where the tmp file must go makes the write fail.
    mkdirSync(file + ".tmp");
    expect(store.burn(s, T0 + 1)).toEqual({ ok: false, reason: "busy" });
    expect(() => store.mint(URI, T0 + 1)).toThrow(GoogleStateBusyError);
    rmSync(file + ".tmp", { recursive: true, force: true });
    expect(store.burn(s, T0 + 2).ok).toBe(true);
  });
});
