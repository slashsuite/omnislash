import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Text,
  Button,
  Caption,
  Card,
  Cluster,
  ClusterGrow,
  Input,
  PageHeader,
  Pill,
  Stack,
} from "@slashsuite/ui-react";
import {
  getCredentials,
  getWhatsappQr,
  startWhatsappPairing,
  checkCredential,
  setCredential,
  type CredentialStatus,
} from "../server/tokens.ts";
import {
  INSECURE_NOTICE,
  checkSummary,
  groupByHome,
  pasteAllowedHere,
  presenceSummary,
  refreshHint,
  ageText,
} from "../lib/credentials.ts";
import { QR_EXPOSURE_NOTICE, qrPanel, type QrState, type WhatsappQrView } from "../lib/whatsappQr.ts";
import type { ChangeEvent } from 'react'

// ── 219: the tokens page. Every credential ob depends on, not only the ones `ob secret list` holds:
// four failures surfaced in two days and three of them were credentials the store does not keep (the
// Keychain master key, github living only in the `gh` CLI, the WhatsApp pairing), so a page that
// listed the store would have shown all-clear through every one of them. 425 dropped router-password
// and claude from this list (same rule as slack/208): nothing should create them.
//
// Three questions per row: is it there (free, always shown), is it valid (a provider call, so it happens
// only when the Check now button is clicked, never on load, never on a timer), and how do I refresh it
// (a paste, an OAuth round trip, or a QR scan, and the row says which rather than
// offering one button that fits none of them).
//
// No credential VALUE reaches this component: the server payload carries presence, timestamps and a
// sentence. The paste box is write-only: it posts and clears, and nothing ever renders a stored value.
//
// 274 adds the one deliberate exception, and it is worth being precise about why it is not a breach of
// that rule: the WhatsApp pairing QR is not a stored credential being displayed, it is a challenge that
// exists only to be scanned and is dead ~20 seconds later. Even so, the raw payload does not reach the
// browser — the server renders it to a PNG and strips the code (see `renderWhatsappQr`).

export const Route = createFileRoute("/tokens")({
  loader: async () => {
    const [credentials, qr] = await Promise.all([getCredentials(), getWhatsappQr()]);
    return { credentials, qr };
  },
  component: Tokens,
});

function PasteBox({ c, onData }: { c: CredentialStatus; onData: (d: CredentialStatus[]) => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    setDone(false);
    try {
      onData(await setCredential({ data: { name: c.name, value } }));
      setValue(""); // the value leaves this component the moment it is sent
      setDone(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap="xs">
      <Cluster gap="xs">
        <Input
          type="password"
          value={value}
          autoComplete="off"
          spellCheck={false}
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            setValue(e.target.value);
            setDone(false);
          }}
          placeholder={`paste a new ${c.label} token`}
          size="sm" width="fill"
        />
        <Button
          size="sm"
          onClick={submit}
          disabled={busy || value.trim().length === 0}
          title="Encrypt this value straight into the store. Refused over a plain-HTTP network connection."
        >
          {busy ? "Storing…" : "Store"}
        </Button>
        {done && <Caption as="span" tone="positive">stored</Caption>}
      </Cluster>
      {err && (
        <Text tone="danger">
          {err}
        </Text>
      )}
    </Stack>
  );
}

function CredentialRow({
  c,
  now,
  canPaste,
  onData,
}: {
  c: CredentialStatus;
  now: number;
  canPaste: boolean;
  onData: (d: CredentialStatus[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const presence = presenceSummary(c);
  const check = checkSummary(c, now);

  const runCheck = async () => {
    setBusy(true);
    setErr(null);
    try {
      onData(await checkCredential({ data: { name: c.name } }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card size="sm">
      <Stack gap="xs">
        <Cluster gap="xs">
          <Text as="span" strong>{c.label}</Text>
          <Caption as="span" tone="muted" mono>
            {c.name}
          </Caption>
          <Pill tone={presence.tone}>{presence.label}</Pill>
          <Pill tone={check.tone}>{check.label}</Pill>
          {c.updated_at && <Caption as="span" tone="muted">stored {ageText(c.updated_at, now)}</Caption>}
          <ClusterGrow />
          {c.checkable && (
            <Button
              variant="outline"
              onClick={runCheck}
              disabled={busy}
              title="Ask the provider whether this credential still works. This is the only thing on the page that leaves the machine."
            >
              {busy ? "Checking…" : "Check now"}
            </Button>
          )}
        </Cluster>

        <Text>{c.purpose}</Text>
        <Caption tone="muted">
          {c.presence_detail}
        </Caption>
        {check.detail && check.state !== "unavailable" && (
          <Caption tone={check.state === "failed" ? "danger" : "muted"}>
            {check.detail}
          </Caption>
        )}

        <Caption tone="muted">
          {refreshHint(c)}
        </Caption>
        <Caption mono>
          {c.command}
        </Caption>
        {c.writable && canPaste && <PasteBox c={c} onData={onData} />}
        {err && (
          <Text tone="danger">
            {err}
          </Text>
        )}
      </Stack>
    </Card>
  );
}

/**
 * The WhatsApp pairing QR (274). The one panel on this page that shows a secret rather than hiding one,
 * and it is a deliberate exception: the QR IS the refresh mechanism, it is worthless the moment it is
 * scanned or its window (60s for the first code, ~20s for later ones) passes, and the alternative was a
 * terminal on the box tailing a log.
 *
 * Two things it must never do. It must never claim a code is scannable when it is not, so the age and the
 * verdict are on screen beside the image and an expired one is greyed and labelled. And it must never sit
 * there when nothing is pairing: `qrPanel` returns `show: false` for the no-file case, so a linked session
 * renders no panel at all.
 *
 * Re-reads on its own interval (a local file read on the same box), faster than the ~20s rotation while
 * something is live so a code cannot expire between the read and the scan. The poll stops on unmount, when
 * the tab goes hidden (OB-1942) and when the panel itself says there is nothing left to watch, so nothing
 * leaves a timer reading a pairing secret off disk.
 */
function PairingPanel({ initial, linked }: { initial: WhatsappQrView; linked: boolean }) {
  const [qr, setQr] = useState<WhatsappQrView>(initial);
  const [err, setErr] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  // OB-1942: the outcome is stamped with the QR state it was produced against, so it can be retired the
  // moment the panel moves on — a "started, waiting for a code" line under a live code is a stale sentence
  // the reader cannot tell from a current one.
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string; state: QrState } | null>(null);
  // OB-1942: a hidden browser tab does not need a pairing secret re-read every 20s. Tracked as state so the
  // poll effect re-arms when the tab comes back.
  const [tabHidden, setTabHidden] = useState(
    () => typeof document !== "undefined" && document.visibilityState === "hidden",
  );
  const panel = qrPanel(qr, { linked });
  // The effect depends on the CADENCE, not on `qr`: every poll returns a new object, so a dep on the
  // state itself would tear the timer down and rebuild it on every tick.
  const pollMs = panel.pollMs === null || tabHidden ? null : panel.pollMs;
  // Read by the visibility handler, which is registered once and must not close over a stale cadence.
  // The PANEL's cadence, not the tab-aware one: on a return to visible the tab-aware value is still the
  // hidden one for this render, but whether there is anything worth reading has not changed.
  const panelPoll = useRef<number | null>(null);
  useEffect(() => {
    panelPoll.current = panel.pollMs;
  });
  // Guards the two setStates against a response that lands after unmount.
  const alive = useRef(true);
  // OB-1942: every read carries a number and only a newer one is applied, so a slow read cannot land on top
  // of the one that replaced it and show a code the bridge has already rotated away.
  const issued = useRef(0);
  const applied = useRef(0);

  /** One read of the QR file, ignored if it is not the newest one in flight. */
  const readOnce = useCallback(() => {
    const seq = ++issued.current;
    void getWhatsappQr()
      .then((next) => {
        if (!alive.current || seq <= applied.current) return; // an older read never overwrites a newer one
        applied.current = seq;
        setQr(next);
        // The Start outcome is retired HERE, where the state it was shown against changes: one mechanism,
        // no extra render, and no resurrecting it by returning to that state later.
        setOutcome((o) => (o && o.state !== next.state ? null : o));
        setErr(null);
      })
      .catch((e: unknown) => {
        // An older read's failure is dropped for the same reason its result would be: the newer read
        // already stands, and an error over a fresh, correct QR is a lie the next success would undo.
        if (!alive.current || seq <= applied.current) return;
        // A failure settles this position too, so a slower older read cannot apply over it (and clear it).
        applied.current = seq;
        // A failed poll is reported, never swallowed into a stale image that keeps looking current.
        setErr(e instanceof Error ? e.message : String(e));
      });
  }, []);

  useEffect(() => {
    const onVisibility = () => {
      const hidden = document.visibilityState === "hidden";
      setTabHidden(hidden);
      // Coming back is a reason to look NOW: the code on screen was read before the tab went away, and
      // its age is frozen, so waiting a whole interval shows a rotation behind.
      if (!hidden && panelPoll.current !== null) readOnce();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [readOnce]);


  useEffect(() => {
    alive.current = true;
    if (pollMs === null) return;
    const id = setInterval(readOnce, pollMs);
    return () => {
      alive.current = false;
      clearInterval(id);
    };
  }, [pollMs, readOnce]);

  const startPairing = async () => {
    setStarting(true);
    setOutcome(null);
    setErr(null);
    try {
      const res = await startWhatsappPairing();
      // A start is a read like any other, ordered by when its ANSWER arrives: the server reads the QR
      // after the click, so a poll that went out during the start is not newer than the result. Ordering
      // it by the click instead dropped a live code that had landed first, for a whole idle interval.
      applied.current = ++issued.current;
      setQr(res.qr);
      // A refusal is an OUTCOME, not an error: the server declined on purpose and said why, and the
      // reason is the useful part. Rendering it as a crash would teach the reader the button is broken.
      setOutcome({ ok: res.ok, message: res.message, state: res.qr.state });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  if (!panel.show) return null;

  return (
    <Card title="WhatsApp pairing">
      <Cluster gap="sm" align="start">
        {panel.showImage && qr.image && (
          <img
            src={qr.image}
            alt="WhatsApp pairing QR code"
            width={240}
            height={240}
            className={`rounded-lg border border-slate-200 bg-white p-2 ${qr.state === "expired" ? "opacity-40" : ""}`}
          />
        )}
        <div className="min-w-64 flex-1">
          <Stack gap="xs">
            <Cluster gap="xs">
              <Text as="span" strong>{panel.headline}</Text>
              <Pill tone={panel.tone}>{qr.state}</Pill>
            </Cluster>
            <Text>{panel.detail ?? qr.detail}</Text>
            {panel.showStart && (
              <Cluster gap="xs">
                <Button
                  size="sm"
                  onClick={startPairing}
                  disabled={starting}
                  title="Start the WhatsApp bridge so it opens a pairing window and emits a QR. Refused if the session is already live."
                >
                  {starting ? "Starting…" : "Start pairing"}
                </Button>
                <Caption as="span" tone="muted">
                  Starts the bridge locally. Have your phone ready: the window closes after a few minutes.
                </Caption>
              </Cluster>
            )}
            {outcome && (
              <Caption tone={outcome.ok ? undefined : "warn"}>
                {outcome.message}
              </Caption>
            )}
            <Caption tone="muted">
              {QR_EXPOSURE_NOTICE}
            </Caption>
            {qr.insecure_mode && (
              <Caption tone="danger">
                {qr.path} is readable by more than its owner. It holds a pairing secret: chmod 600 it.
              </Caption>
            )}
            <Caption tone="muted" mono>
              {qr.path}
            </Caption>
            {err && (
              <Text tone="danger">
                the pairing read failed: {err}
              </Text>
            )}
          </Stack>
        </div>
      </Cluster>
    </Card>
  );
}

function Tokens() {
  const { credentials: initial, qr } = Route.useLoaderData();
  const [rows, setRows] = useState<CredentialStatus[]>(initial);
  // Fixed at render: a page that re-derives "checked 3m ago" every second is a clock, not a status page,
  // and every action here already returns a fresh payload.
  // oxlint-disable-next-line react/purity -- the clock is read once per render on purpose, as the comment above says
  const now = Date.now();
  const canPaste =
    typeof window === "undefined" ? false : pasteAllowedHere({ protocol: window.location.protocol, hostname: window.location.hostname });

  const groups = groupByHome(rows);
  const missing = rows.filter((r) => !r.present);
  const failed = rows.filter((r) => r.last_check && !r.last_check.ok);

  return (
    <>
      <PageHeader
        title="Tokens"
        description="Every credential ob depends on: is it there, is it valid, and how do you refresh it. A check calls the provider, so it only happens when you click it. No stored value is ever shown here — the one exception is the WhatsApp pairing QR, which only exists to be scanned and expires within a minute."
      />
      <Stack>
        {/* `linked` comes off the credential row rather than a second probe: the QR file cannot tell a
            linked session from an un-patched bridge, and that distinction decides whether this panel is a
            useless permanent card or the one thing on the page you need. */}
        <PairingPanel initial={qr} linked={rows.find((r) => r.name === "whatsapp")?.present ?? false} />

        {(missing.length > 0 || failed.length > 0) && (
          <Card title="Needs attention" count={missing.length + failed.length}>
            <Text>
              {missing.length > 0 && <>{missing.map((m) => m.name).join(", ")} missing. </>}
              {failed.length > 0 && <>{failed.map((m) => m.name).join(", ")} failed the last check.</>}
            </Text>
          </Card>
        )}

        {!canPaste && (
          <Card title="Why there is no paste box">
            <Text>{INSECURE_NOTICE}</Text>
          </Card>
        )}

        {rows.length === 0 ? (
          <Card title="Credentials" count={0}>
            <Text tone="muted">No credentials are declared, which should be impossible.</Text>
          </Card>
        ) : (
          groups.map((g) => (
            <Card key={g.home} title={g.label} count={g.rows.length}>
              <Stack gap="sm">
                {g.rows.map((c) => (
                  <CredentialRow key={c.name} c={c} now={now} canPaste={canPaste} onData={setRows} />
                ))}
              </Stack>
            </Card>
          ))
        )}
      </Stack>
    </>
  );
}
