import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Caption, Card, Cluster, ListRow, PageHeader, Pill, Stack, Text } from "@hackcove/ui-react";
import { ItemDrawer } from "../../../../platform/dashboard-kit/src/components/ItemDrawer.tsx";
import { useRealtime } from "../../../../platform/dashboard-kit/src/lib/useRealtime.ts";
import type { AgentRow } from "../../../../platform/dashboard-kit/src/lib/types.ts";
import { getHome, getItem, setTodayRank, transitionItem } from "../server/items.ts";

// OS-24 (OB-2199 step 8): the OB dashboard's home. "To review" is the live snapshot's needs_review (the builders
// parked on a human), each row opening its ticket in the shared item drawer; the focus list is the snapshot's
// ranked focus (items with a today rank), each row opening that item. The loader gives the first paint; a live
// push replaces both lists. The drawer's start / close / rank go through src/server/items.ts.

export const Route = createFileRoute("/")({
  loader: () => getHome(),
  component: Home,
});

function ReviewRow({ a, divided, onOpen }: { a: AgentRow; divided: boolean; onOpen: (id: string) => void }) {
  const label = <Text as="span" lines={1}>{a.note ?? a.branch ?? a.id}</Text>;
  const leading = <Pill tone="warn">{a.ticket ?? a.id}</Pill>;
  // A builder registered without a ticket has nothing to open; its row still shows.
  if (!a.ticket) return <ListRow size="sm" divided={divided} leading={leading}>{label}</ListRow>;
  const ticket = a.ticket;
  return (
    <ListRow size="sm" divided={divided} leading={leading} onClick={() => onOpen(ticket)}>
      {label}
    </ListRow>
  );
}

function Home() {
  const initial = Route.useLoaderData();
  const { snap } = useRealtime();
  const s = snap?.status ?? initial;
  const router = useRouter();
  const [openId, setOpenId] = useState<string | null>(null);
  // buildStatus already ranks focus (today_rank ascending, ranked items only).
  const focus = s.focus;

  return (
    <>
      <PageHeader title="OB" description="What is waiting on you: builders parked on your answer, and today's ranked focus." />
      <Stack>
        <Card title="To review" count={s.needs_review.length} flush={s.needs_review.length > 0}>
          {s.needs_review.length === 0 ? (
            <Text tone="muted">Nothing to review: no builder is waiting on you.</Text>
          ) : (
            s.needs_review.map((a, i) => <ReviewRow key={a.id} a={a} divided={i > 0} onOpen={setOpenId} />)
          )}
        </Card>

        <Card title="Focus" count={focus.length} flush={focus.length > 0}>
          {focus.length === 0 ? (
            <Text tone="muted">No ranked focus: add an item to Today from its drawer.</Text>
          ) : (
            focus.map((item, i) => (
              <ListRow
                key={item.id}
                size="sm"
                divided={i > 0}
                onClick={() => setOpenId(item.id)}
                leading={
                  <Caption as="span" tone="muted" mono numeric>
                    {item.today_rank}
                  </Caption>
                }
                trailing={
                  item.status === "blocked" ? (
                    <Cluster gap="xs">
                      <Pill tone="danger">blocked</Pill>
                      {item.block_owner && <Caption as="span" tone="muted">{item.block_owner}</Caption>}
                    </Cluster>
                  ) : (
                    <Caption as="span" tone="muted">{item.status}</Caption>
                  )
                }
              >
                <Text as="span" lines={1}>{item.title}</Text>
              </ListRow>
            ))
          )}
        </Card>
      </Stack>
      <ItemDrawer
        itemId={openId}
        onClose={() => {
          setOpenId(null);
          // A drawer write changes the lists; re-read them so the page is right even with the live socket down.
          void router.invalidate();
        }}
        getItem={getItem}
        transitionItem={transitionItem}
        setTodayRank={setTodayRank}
      />
    </>
  );
}
