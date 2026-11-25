import { useEffect, useState, type ChangeEvent } from "react";
import {
  Text,
  Button,
  ButtonGroup,
  Callout,
  Caption,
  Cluster,
  Divider,
  Drawer,
  Field,
  Input,
  KeyValue,
  KeyValueList,
  MetaList,
  Overline,
  Pill,
  Stack,
  TextLink,
} from "@slashsuite/ui-react";
import { fmtDateTime } from "../lib/localTime.ts";
import type { ItemDetail } from "../lib/types.ts";

// Shared item-detail drawer (#46 — UI F5). Opens over any item row, renders the `ob show`-level detail
// (fields · tags · links · linear ref · type detail · activity · PRs) and wires start / ready / block /
// close / reopen / today-rank to the workflow server fns. A slide-over on the right. FEEL left basic —
// data + actions are the point; the visual polish is the user's to tune.

// One button per status in the server's valid_next (OB-1939), labelled by this map; a status with no
// label shows its raw name, so a status added later is never hidden. `open` is special-cased below.
const STATUS_LABEL: Record<string, string> = {
  in_progress: "Start",
  ready: "Ready",
  merged: "Merged",
  qa_ready: "QA ready",
  qa: "QA",
  qa_rework: "QA rework",
  done: "Close",
  blocked: "Block…",
};

type Transition = "start" | "ready" | "close" | "reopen" | "unblock" | "move";

// The action each status is sent as. Everything not listed is a generic `move` with `to`.
const STATUS_ACTION: Record<string, Transition> = { in_progress: "start", ready: "ready", done: "close" };

// The three server functions the drawer calls (OB-2204). The kit imports no app's server/ file: each app
// passes its own createServerFn wrappers, called the way TanStack Start calls one, with `{ data }`.
type GetItemFn = (args: { data: { id: string } }) => Promise<ItemDetail>;
type TransitionItemFn = (args: {
  data: { id: string; action: Transition | "block"; reason?: string; to?: string };
}) => Promise<ItemDetail>;
type SetTodayRankFn = (args: { data: { id: string; rank: number | null } }) => Promise<ItemDetail>;

interface ItemDrawerProps {
  itemId: string | null;
  onClose: () => void;
  getItem: GetItemFn;
  transitionItem: TransitionItemFn;
  setTodayRank: SetTodayRankFn;
}

// One instance per item (OB-1939): switching items remounts the drawer, so the previous item's detail,
// busy flag, form fields and in-flight transition cannot show up under, or write over, the next item.
export function ItemDrawer(props: ItemDrawerProps) {
  return <ItemDrawerBody key={props.itemId ?? ""} {...props} />;
}

function ItemDrawerBody({ itemId, onClose, getItem, transitionItem, setTodayRank }: ItemDrawerProps) {
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  // Keyed per item, so the effect below runs once per instance: an instance with an item starts loading.
  const [loading, setLoading] = useState(Boolean(itemId));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [rank, setRank] = useState("");
  const [showBlock, setShowBlock] = useState(false);

  useEffect(() => {
    if (!itemId) return;
    let live = true;
    getItem({ data: { id: itemId } })
      .then((d) => {
        if (live) setDetail(d);
      })
      .catch((e) => {
        if (live) setErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [itemId, getItem]); // the server fns are module-level in each app, so getItem never changes

  if (!itemId) return null;

  const run = async (fn: () => Promise<ItemDetail>, after?: () => void) => {
    setBusy(true);
    setErr(null);
    try {
      setDetail(await fn());
      after?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doTransition = (action: Transition, to?: string) =>
    run(() => transitionItem({ data: { id: itemId, action, ...(to ? { to } : {}) } }));

  // The buttons: Unblock first on a blocked item, then one per valid_next status. The server's reopen is
  // done-only, so `open` reads "Reopen" from done and "Back to open" (a plain move) from anywhere else.
  const buttons: { key: string; label: string; primary: boolean; run: () => void; pressed?: boolean }[] = [];
  if (detail?.status === "blocked") {
    buttons.push({ key: "unblock", label: "Unblock", primary: true, run: () => void doTransition("unblock") });
  }
  for (const status of detail?.valid_next ?? []) {
    if (status === "blocked") {
      buttons.push({ key: status, label: STATUS_LABEL.blocked, primary: false, pressed: showBlock, run: () => setShowBlock((v) => !v) });
    } else if (status === "open") {
      const reopen = detail?.status === "done";
      buttons.push({
        key: status,
        label: reopen ? "Reopen" : "Back to open",
        primary: false,
        run: () => void (reopen ? doTransition("reopen") : doTransition("move", "open")),
      });
    } else {
      const action = STATUS_ACTION[status];
      buttons.push({
        key: status,
        label: STATUS_LABEL[status] ?? status,
        primary: status === "in_progress" && detail?.status !== "blocked",
        run: () => void (action ? doTransition(action) : doTransition("move", status)),
      });
    }
  }

  const doBlock = () => {
    if (!reason.trim()) {
      setErr("Block needs a reason.");
      return;
    }
    void run(
      () => transitionItem({ data: { id: itemId, action: "block", reason: reason.trim() } }),
      () => {
        setShowBlock(false);
        setReason("");
      },
    );
  };

  const doToday = () => {
    const n = rank.trim() === "" ? null : Number(rank);
    if (n !== null && !Number.isInteger(n)) {
      setErr("Rank must be a whole number (or blank for the next slot).");
      return;
    }
    void run(() => setTodayRank({ data: { id: itemId, rank: n } }), () => setRank(""));
  };

  const stamp = fmtDateTime;

  return (
    <Drawer
      title={detail?.title ?? (loading ? "Loading…" : "Item")}
      onClose={onClose}
      footer={
        detail && (
          <Stack gap="sm" width="full">
            <ButtonGroup>
              {buttons.map((b) => (
                <Button
                  key={b.key}
                  variant={b.primary ? undefined : "outline"}
                  pressed={b.pressed}
                  onClick={b.run}
                  disabled={busy}
                >
                  {b.label}
                </Button>
              ))}
            </ButtonGroup>

            {showBlock && (
              <Cluster gap="xs">
                <Input
                  type="text"
                  width="fill"
                  value={reason}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setReason(e.target.value)}
                  placeholder="block reason…"
                />
                <Button onClick={doBlock} disabled={busy}>
                  Confirm block
                </Button>
              </Cluster>
            )}

            <Divider />
            <Cluster gap="xs">
              <Field label="today rank" layout="row">
                <Input
                  type="number"
                  value={rank}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setRank(e.target.value)}
                  placeholder="next"
                  size="sm" width="xs" numeric
                />
              </Field>
              <Button variant="outline" size="sm" onClick={doToday} disabled={busy}>
                Add to Today
              </Button>
            </Cluster>
          </Stack>
        )
      }
    >
      <Stack gap="md">
        <MetaList>
          <span>#{itemId}</span>
          {detail && <span>{detail.type}</span>}
          {detail?.kind && <span>{detail.kind}</span>}
        </MetaList>

        {err && (
          <Callout tone="danger">{err}</Callout>
        )}

        {detail && (
          <>
            {/* Fields */}
            <KeyValueList align="start">
              <KeyValue label="status">
                <Pill tone={detail.status === "blocked" ? "danger" : detail.status === "done" ? "positive" : "neutral"}>
                  {detail.status}
                </Pill>
              </KeyValue>
              <KeyValue label="priority">
                {detail.effective_priority}{detail.priority ? " (explicit)" : " (derived)"}
              </KeyValue>
              <KeyValue label="project">{detail.project ?? "—"}</KeyValue>
              {detail.today_rank !== null && <KeyValue label="today">rank {detail.today_rank}</KeyValue>}
              {detail.status === "blocked" && (
                <KeyValue label="blocked">
                  {detail.block_reason ?? "—"}
                  {detail.block_owner ? ` (owner: ${detail.block_owner})` : ""}
                </KeyValue>
              )}
              <KeyValue label="created">{stamp(detail.created_at)}</KeyValue>
              <KeyValue label="updated">{stamp(detail.updated_at)}</KeyValue>
              {detail.closed_at && <KeyValue label="closed">{stamp(detail.closed_at)}</KeyValue>}
            </KeyValueList>

            {detail.tags.length > 0 && (
              <Cluster gap="xs">
                {detail.tags.map((t) => (
                  <Pill key={t} tone="info">{t}</Pill>
                ))}
              </Cluster>
            )}

            {detail.linear?.url && (
              <TextLink href={detail.linear.url} external>
                {detail.linear.linear_id ?? "linear"}
                {detail.linear.cached_title ? ` — ${detail.linear.cached_title}` : ""}
              </TextLink>
            )}

            {detail.body && (
              <Stack gap="xs">
                <Overline as="h3" tone="muted">Body</Overline>
                <Text preserveNewlines>{detail.body}</Text>
              </Stack>
            )}

            {detail.detail && Object.keys(detail.detail).length > 0 && (
              <Stack gap="xs">
                <Overline as="h3" tone="muted">Detail</Overline>
                <KeyValueList align="start">
                  {Object.entries(detail.detail)
                    .filter(([k, v]) => k !== "item_id" && v !== null && v !== undefined && v !== "")
                    .map(([k, v]) => (
                      <KeyValue key={k} label={k}>{String(v)}</KeyValue>
                    ))}
                </KeyValueList>
              </Stack>
            )}

            {detail.links.length > 0 && (
              <Stack gap="xs">
                <Overline as="h3" tone="muted">Links</Overline>
                <Stack as="ul" gap="xs">
                  {detail.links.map((l, i) => (
                    <li key={i}>
                      <Text as="span" tone="muted">{l.direction === "out" ? "→" : "←"} {l.rel_type}</Text> <Text as="span">#{l.other}</Text>
                    </li>
                  ))}
                </Stack>
              </Stack>
            )}

            {detail.prs.length > 0 && (
              <Stack gap="xs">
                <Overline as="h3" tone="muted">PRs</Overline>
                <Stack as="ul" gap="xs">
                  {detail.prs.map((p) => (
                    <li key={p.pr}>
                      <Cluster gap="xs">
                        {p.url ? (
                          <TextLink href={p.url} external>{p.pr}</TextLink>
                        ) : (
                          <Text as="span" strong>{p.pr}</Text>
                        )}
                        {p.latest_type && <Caption as="span">{p.latest_type}</Caption>}
                      </Cluster>
                    </li>
                  ))}
                </Stack>
              </Stack>
            )}

            {detail.events.length > 0 && (
              <Stack gap="xs">
                <Overline as="h3" tone="muted">Activity</Overline>
                <Stack as="ul" gap="xs">
                  {detail.events.map((e) => (
                    <li key={e.id}>
                      <Cluster gap="xs" align="baseline">
                        <Caption as="span" numeric>{stamp(e.ts)}</Caption>
                        {e.source && <Pill>{e.source}</Pill>}
                        <Text as="span">{e.type}</Text>
                        {e.actor && <Caption as="span">by {e.actor}</Caption>}
                      </Cluster>
                    </li>
                  ))}
                </Stack>
              </Stack>
            )}
          </>
        )}
      </Stack>
    </Drawer>
  );
}
