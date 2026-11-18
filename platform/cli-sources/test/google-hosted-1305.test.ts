// ob 1305 -- the pure half of the hosted Google flow: the one-time state store and the callback page.
//
// The state is the CSRF guard for the API's only unauthenticated routes, so these are the rules it must
// keep regardless of HTTP: single use, short TTL, an expired state refused as expired on every retry (never
// burned, never usable again, OB-1935), a named reason for every refusal, and a bounded set because a mint
// is unauthenticated.
import { describe, expect, test } from "bun:test";
import {
  GOOGLE_CALLBACK_PATH,
  STATE_TTL_MS,
  createGoogleStateStore,
  hostedCallbackPage,
  hostedRedirectUri,
  requestOrigin,
  stateRefusalSentence,
} from "../src/google-hosted.ts";

const URI = "https://ob-api.example.test/api/ob/google/callback";

describe("the hosted state store (1305)", () => {
  test("mint → burn once with the bound redirect_uri; the second burn is a refused replay", () => {
    const states = createGoogleStateStore();
    const state = states.mint(URI, 1_000);
    const first = states.burn(state, 1_001);
    expect(first).toEqual({ ok: true, redirectUri: URI, issuedAt: 1_000 });
    const replay = states.burn(state, 1_002);
    expect(replay).toEqual({ ok: false, reason: "reused" });
  });

  test("states are unguessable and distinct", () => {
    const states = createGoogleStateStore();
    const a = states.mint(URI);
    const b = states.mint(URI);
    expect(a).toHaveLength(32);
    expect(a).not.toBe(b);
  });

  test("absent state is `missing`, never exchanged", () => {
    const states = createGoogleStateStore();
    expect(states.burn(null)).toEqual({ ok: false, reason: "missing" });
    expect(states.burn("")).toEqual({ ok: false, reason: "missing" });
    expect(states.burn(undefined)).toEqual({ ok: false, reason: "missing" });
  });

  test("a state this server never minted is `unknown`", () => {
    const states = createGoogleStateStore();
    expect(states.burn("deadbeef".repeat(4))).toEqual({ ok: false, reason: "unknown" });
  });

  test("expiry is refused BY NAME, and the expired state stays refused", () => {
    const states = createGoogleStateStore();
    const state = states.mint(URI, 1_000);
    expect(states.burn(state, 1_000 + STATE_TTL_MS + 1)).toEqual({ ok: false, reason: "expired" });
    // OB-1935: expired is refused without burning, so a retry still reads as expired (never usable).
    expect(states.burn(state, 1_000 + STATE_TTL_MS + 2)).toEqual({ ok: false, reason: "expired" });
  });

  test("a state is refused once minted even if the redirect_uri differs — the binding wins", () => {
    const states = createGoogleStateStore();
    const state = states.mint("http://127.0.0.1:1234", 5_000);
    expect(states.burn(state, 5_001)).toEqual({
      ok: true,
      redirectUri: "http://127.0.0.1:1234",
      issuedAt: 5_000,
    });
  });

  test("the set is bounded: a burst of mints cannot grow it without limit", () => {
    const states = createGoogleStateStore();
    const first = states.mint(URI, 0);
    for (let i = 0; i < 1_000; i++) states.mint(URI, 0);
    // The oldest was evicted; the newest is still usable.
    expect(states.burn(first, 0)).toEqual({ ok: false, reason: "unknown" });
    expect(states.burn(states.mint(URI, 0), 0).ok).toBe(true);
  });

  test("inspect does NOT burn: it answers the bound URI and leaves the callback's burn to the callback", () => {
    const states = createGoogleStateStore();
    const state = states.mint(URI, 1_000);
    expect(states.inspect(state, 1_001)).toEqual({ ok: true, redirectUri: URI, issuedAt: 1_000 });
    // Still usable by the callback.
    expect(states.burn(state, 1_002).ok).toBe(true);
    // …and only then does it read as a replay.
    expect(states.inspect(state, 1_003)).toEqual({ ok: false, reason: "reused" });
  });

  test("inspect names the same refusals as burn: missing, unknown, expired", () => {
    const states = createGoogleStateStore();
    expect(states.inspect(null)).toEqual({ ok: false, reason: "missing" });
    expect(states.inspect("nope")).toEqual({ ok: false, reason: "unknown" });
    const state = states.mint(URI, 1_000);
    expect(states.inspect(state, 1_000 + STATE_TTL_MS + 1)).toEqual({ ok: false, reason: "expired" });
    // An inspect never burns, so this expired state is still refused as expired (not as a replay).
    expect(states.burn(state, 1_000 + STATE_TTL_MS + 2)).toEqual({ ok: false, reason: "expired" });
  });

  test("every refusal has a sentence that names it, and they are all distinct", () => {
    const sentences = (["missing", "expired", "reused", "unknown", "busy"] as const).map(stateRefusalSentence);
    for (const sentence of sentences) expect(sentence.length).toBeGreaterThan(10);
    expect(new Set(sentences).size).toBe(5);
    expect(stateRefusalSentence("busy")).toContain("busy or unreadable");
    expect(stateRefusalSentence("reused")).toContain("already used");
    expect(stateRefusalSentence("expired")).toContain("expired");
    expect(stateRefusalSentence("unknown")).toContain("not minted by this server");
  });
});

describe("the callback page (1305)", () => {
  test("success says one line and states plainly whether a refresh token was issued", () => {
    const yes = hostedCallbackPage({ refreshToken: true });
    expect(yes).toContain("done — you can close this");
    expect(yes).toContain("Refresh token issued");
    expect(yes).toContain("secret <code>google</code>");
    const no = hostedCallbackPage({ refreshToken: false });
    expect(no).toContain("No refresh token was issued");
    expect(no).not.toContain("Refresh token issued ✓");
  });

  test("a refusal renders its reason ESCAPED (Google's error parameter is attacker text)", () => {
    const page = hostedCallbackPage({ reason: "<script>alert(1)</script>" });
    expect(page).not.toContain("<script>");
    expect(page).toContain("&lt;script&gt;");
  });
});

describe("redirect_uri derivation (1305)", () => {
  test("a configured URI wins; otherwise the request origin plus the callback path", () => {
    const req = new Request("http://api-host.local/api/ob/google/auth");
    const url = new URL(req.url);
    expect(hostedRedirectUri(URI, req, url)).toBe(URI);
    expect(hostedRedirectUri(undefined, req, url)).toBe(`http://api-host.local${GOOGLE_CALLBACK_PATH}`);
    expect(hostedRedirectUri("  ", req, url)).toBe(`http://api-host.local${GOOGLE_CALLBACK_PATH}`);
  });

  test("X-Forwarded-Proto/Host are honored — the tunnel's https URL, not Bun's local http", () => {
    const req = new Request("http://127.0.0.1:5050/api/ob/google/auth", {
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "ob-api.example.test" },
    });
    expect(requestOrigin(req, new URL(req.url))).toBe("https://ob-api.example.test");
    expect(hostedRedirectUri(null, req, new URL(req.url))).toBe(
      "https://ob-api.example.test/api/ob/google/callback",
    );
  });
});
