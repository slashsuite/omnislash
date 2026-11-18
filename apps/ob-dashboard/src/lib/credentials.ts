import type { CredentialStatus } from "../../../cli/src/credentials.ts";

// 219: the tokens page's view model. The page asks three questions of every credential (is it there,
// is it valid, how do I refresh it) and this module answers them as text and tone, so the answers are
// testable without a browser. Nothing here ever receives a credential value: a CredentialStatus carries
// presence, timestamps and a sentence, and that is all the page has to render.

export type Tone = "neutral" | "warn" | "positive" | "info" | "danger";

/** How long ago, in the coarse units this page needs. Under a minute reads as "just now". */
export function ageText(iso: string, now: number): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "at an unknown time";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

/**
 * The validity line. Three outcomes, not two: a credential nobody has checked is NOT a credential that
 * failed, and collapsing those was the whole problem this page exists to fix: a thing that looks fine
 * because nothing has ever asked it a question.
 */
export type CheckState = "never" | "ok" | "failed" | "unavailable";

export interface CheckSummary {
  state: CheckState;
  label: string;
  detail: string;
  tone: Tone;
}

export function checkSummary(c: CredentialStatus, now: number): CheckSummary {
  if (!c.checkable) {
    return { state: "unavailable", label: "no live check", detail: c.purpose, tone: "neutral" };
  }
  if (!c.last_check) {
    return {
      state: "never",
      label: "never checked",
      detail: "Nothing has asked the provider whether this still works.",
      tone: "warn",
    };
  }
  const when = ageText(c.last_check.checked_at, now);
  return c.last_check.ok
    ? { state: "ok", label: `valid, checked ${when}`, detail: c.last_check.detail ?? "", tone: "positive" }
    : { state: "failed", label: `FAILED, checked ${when}`, detail: c.last_check.detail ?? "", tone: "danger" };
}

export interface PresenceSummary {
  label: string;
  tone: Tone;
}

export function presenceSummary(c: CredentialStatus): PresenceSummary {
  if (!c.present) return { label: "missing", tone: "danger" };
  // Present but not where it should be: github living only in the `gh` CLI is what ob 185's audit found,
  // and on the server there is no `gh` login to fall back to, so "present" alone would be a lie.
  if (c.home === "store" && !c.updated_at) return { label: "present, but not in the store", tone: "warn" };
  return { label: "present", tone: "positive" };
}

/** What refreshing this one actually costs, said plainly rather than pretending one button fits all. */
export function refreshHint(c: CredentialStatus): string {
  switch (c.refresh) {
    case "paste":
      return "Paste a new token below, or run the command on the machine itself.";
    case "oauth":
      return "An OAuth round trip through your browser. It cannot be a paste: run the command in a terminal and approve it with Google.";
    case "login":
      return "An interactive login in a terminal. Nothing on a web page can complete it, and the server needs its own (ob 211).";
    case "file":
      return "A file on disk, on the machine that reads it. Write it there and chmod 600.";
    case "keychain":
      return "It lives in the OS keychain, not in ob. On the server it is a 0600 file named by $OMNISLASH_MASTER_KEY_FILE.";
    case "qr":
      // The one refresh a web page completes by SHOWING rather than by collecting (274): the pairing panel
      // at the top of this page renders the QR and the phone does the rest, so nothing is typed in here.
      return "Scan the pairing QR with WhatsApp on your phone (Settings, Linked devices). The pairing panel at the top of this page shows it while the bridge is emitting one.";
  }
}

export const HOME_LABELS: Record<CredentialStatus["home"], string> = {
  store: "In the encrypted store",
  keychain: "In the OS keychain",
  file: "A file on disk",
  external: "Another tool's own login",
};

/** Grouped by where the credential lives, store first, because that is the axis that decides the fix. */
export function groupByHome(rows: CredentialStatus[]): Array<{ home: CredentialStatus["home"]; label: string; rows: CredentialStatus[] }> {
  const order: CredentialStatus["home"][] = ["store", "keychain", "file", "external"];
  return order
    .map((home) => ({ home, label: HOME_LABELS[home], rows: rows.filter((r) => r.home === home) }))
    .filter((g) => g.rows.length > 0);
}

/**
 * Whether this browser may send a pasted token at all. The server refuses regardless (writeGate is the
 * real gate); this only decides whether the page offers a box it knows will be refused, and lets it say
 * why up front instead of after the paste.
 */
export function pasteAllowedHere(location: { protocol: string; hostname: string }): boolean {
  if (location.protocol === "https:") return true;
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(location.hostname.toLowerCase());
}

export const INSECURE_NOTICE =
  "This page is on plain HTTP over the network, so it will not accept a pasted token: the value would cross the house network in the clear. Reach it over https (ob 220), or set the token on the machine itself with `ob secret set <name>`.";
