import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Text, Button, ButtonGroup, Caption, Card, Cluster, ClusterGrow, PageHeader, Stack, Pill } from "@hackcove/ui-react";
import { getAlerts, ackAlert, snoozeAlert, type Alert } from "../server/alerts.ts";
import { useRealtime } from "../../../../platform/dashboard-kit/src/lib/useRealtime.ts";

// OB-2207: moved here from the personal dashboard (OB-2199 step 5); :5050/alerts is gone.
// #45 UI F1: the alert / notification centre over the alert engine (computeAlerts). The list
// is the SAME derivation `ob alerts` shows (un-acked alerts, snoozes filtered). Alerts are grouped by
// rule; each has an Ack (dismiss) + Snooze action that writes an alert_ack pinned to the alert's current
// state_hash, so it re-surfaces once the underlying state changes. Nothing here ever sends externally.
// Live: the WS snapshot carries alertCount (drives the header bell, AlertBell.tsx); a tick means the DB changed, so we
// re-fetch the full alert list (the snapshot doesn't carry the alert rows themselves).

export const Route = createFileRoute("/alerts")({
  loader: () => getAlerts(),
  component: Alerts,
});

/** Pill tone per rule: the most urgent rules warmer. */
function toneOf(rule: number): "danger" | "warn" | "positive" | "neutral" {
  if (rule === 1 || rule === 4) return "danger"; // PR unreviewed / blocked
  // 218: a daemon job that keeps failing, or one installed nowhere, is dead ingestion, the loudest
  // thing on this page, since the whole class went unnoticed for weeks four times over.
  // 219: a credential the provider has REJECTED is the same outage one layer down, so it reads as loud
  // as a dead job. The Tokens page is where it gets fixed.
  if (rule === 7 || rule === 9 || rule === 11) return "danger"; // job failing / job never ran / credential invalid
  if (rule === 2 || rule === 3 || rule === 6 || rule === 8) return "warn"; // aging / stale branch / overdue contact / job stale
  return "neutral"; // scope change
}

function AlertRow({ a, onData }: { a: Alert; onData: (d: Alert[]) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async (fn: () => Promise<Alert[]>) => {
    setBusy(true);
    setErr(null);
    try {
      onData(await fn());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card tone="neutral" size="sm">
      <Stack gap="xs">
        <Cluster gap="xs">
          <Pill tone={toneOf(a.rule)}>{a.label}</Pill>
          <Caption as="span" tone="muted" mono>{a.entity}</Caption>
          <ClusterGrow />
          <ButtonGroup>
            <Button
              variant="outline"
              onClick={() => run(() => snoozeAlert({ data: { key: a.key } }))}
              disabled={busy}
              title="Snooze: hide until the underlying state changes."
            >
              Snooze
            </Button>
            <Button
              onClick={() => run(() => ackAlert({ data: { key: a.key } }))}
              disabled={busy}
              title="Acknowledge: dismiss until the underlying state changes."
            >
              Ack
            </Button>
          </ButtonGroup>
        </Cluster>
        <Text>{a.message}</Text>
        {err && <Text tone="danger">{err}</Text>}
      </Stack>
    </Card>
  );
}

function Alerts() {
  const initial = Route.useLoaderData();
  const [alerts, setAlerts] = useState<Alert[]>(initial);
  const { snap } = useRealtime();

  // A WS tick means the DB changed (a new alert may have appeared or cleared). The snapshot carries the
  // count but not the rows, so re-fetch the list. Local ack/snooze already setAlerts synchronously.
  useEffect(() => {
    if (!snap) return;
    let live = true;
    getAlerts()
      .then((d) => live && setAlerts(d))
      .catch(() => {}); // a refresh failure never blanks the view
    return () => {
      live = false;
    };
  }, [snap]);

  // Group by rule, preserving computeAlerts' rule-then-key order.
  const groups = useMemo(() => {
    const byRule = new Map<number, { label: string; items: Alert[] }>();
    for (const a of alerts) {
      const g = byRule.get(a.rule) ?? { label: a.label, items: [] };
      g.items.push(a);
      byRule.set(a.rule, g);
    }
    return [...byRule.entries()].sort((x, y) => x[0] - y[0]).map(([, g]) => g);
  }, [alerts]);

  return (
    <>
      <PageHeader
        title="Alerts"
        description="What needs your attention, surfaced by the alert engine. Ack or snooze an alert to hide it until the underlying state changes. Nothing here ever sends a message."
      />
      <Stack>
        {alerts.length === 0 ? (
          <Card title="Alerts" count={0}>
            <Text tone="muted">All clear: no alerts need attention.</Text>
          </Card>
        ) : (
          groups.map((g) => (
            <Card key={g.label} title={g.label} count={g.items.length}>
              <Stack gap="sm">
                {g.items.map((a) => (
                  <AlertRow key={a.key} a={a} onData={setAlerts} />
                ))}
              </Stack>
            </Card>
          ))
        )}
      </Stack>
    </>
  );
}
