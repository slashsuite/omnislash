// OS-23: the OpenCode Go credit state on the Models page, moved from omnibus's retired Reviewers page. It reads
// the last recorded `ob creds check opencode-go` and never calls the provider. Pure and browser-safe (the import
// below is a type only, erased at build).

import type { CredentialCheckRow } from "../../../cli/src/credentials.ts";

export type CreditTone = "positive" | "warn" | "danger" | "neutral";

/** The status from the last recorded check. A never-checked credential is not a failed one. */
export function creditState(last: CredentialCheckRow | null): { label: string; tone: CreditTone } {
  if (!last) return { label: "not checked yet", tone: "neutral" };
  // A check fails for more than credit (no key stored, the network, a changed reply): the page shows the
  // recorded detail beside this, rather than guess the cause.
  if (!last.ok) return { label: "failed", tone: "danger" };
  if (last.detail && /running low/i.test(last.detail)) return { label: "running low", tone: "warn" };
  return { label: "ok", tone: "positive" };
}

/**
 * The check time as `2026-11-24 08:30 UTC`. UTC and fixed, so the server's render and the browser's hydrate
 * agree whatever either's time zone; an unreadable stamp is shown as it was stored.
 */
export function checkedAtText(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
