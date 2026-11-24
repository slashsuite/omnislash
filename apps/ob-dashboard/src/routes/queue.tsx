import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { GroupPicker, groupSearch, type GroupSearch } from "../components/GroupPicker.tsx";
import { Callout, Caption, Cluster, PageHeader, Pill, Select, SortableItem, SortableList, SortableSection, Stack, type SortableMove } from "@hackcove/ui-react";
import { ItemDrawer } from "../../../../platform/dashboard-kit/src/components/ItemDrawer.tsx";
import { useRealtime } from "../../../../platform/dashboard-kit/src/lib/useRealtime.ts";
import type { QueueBand, QueueRow } from "../../../../platform/dashboard-kit/src/server/queue.ts";
import { getItem, getQueue, setPriority, setQueueOrder, setTodayRank, transitionItem } from "../server/items.ts";

// OS-25: the execution queue, next task on top. OS-185: it opens on a group (a team, `?team=`) with the group's
// projects merged and each row naming its project, and narrows to one project with `?project=`: its open items in `ob next --project` order, under one
// heading per priority band (each with its count, an empty one shown as a drop row). A drag inside a band changes
// the order only; a drag into another band takes that band's priority and places the item there (setQueueOrder,
// the core `ob order` runs), and a drop on an empty band puts it first with that priority. The row's priority
// Select sets the priority alone. The ref opens the item in the shared drawer. An `ob order` or `ob edit` from the
// CLI moves the live snapshot's itemsStamp, and the page re-reads.

export const Route = createFileRoute("/queue")({
  validateSearch: (s: Record<string, unknown>): GroupSearch => groupSearch(s),
  loaderDeps: ({ search }) => ({ team: search.team, project: search.project }),
  loader: async ({ deps }) => await getQueue({ data: deps }),
  component: Queue,
});

/** The pill a row shows when it is not plain open: being built, in review or blocked keep their place. */
function statusPill(status: string) {
  if (status === "open" || status === "todo" || status === "active" || status === "draft") return null;
  if (status === "in_progress") return <Pill size="sm" tone="info">Building</Pill>;
  if (status === "blocked") return <Pill size="sm" tone="danger">Blocked</Pill>;
  if (status === "ready" || status === "merged" || status === "qa_ready" || status === "qa") return <Pill size="sm" tone="warn">Review</Pill>;
  return <Pill size="sm">{status}</Pill>;
}

/**
 * One row. Called as a function, not rendered as a component: SortableSection counts, and SortableList places,
 * only the SortableItem elements that are its direct children.
 */
function row(
  row: QueueRow,
  bands: QueueBand[],
  onOpen: (id: string) => void,
  onPriority: (id: string, priority: number) => void,
  showProject: boolean,
) {
  const ref = row.ref ?? row.id;
  return (
    <SortableItem key={row.id} id={row.id} title={row.title}>
      <Pill size="sm" tone="accent" onClick={() => onOpen(row.id)}>
        {ref}
      </Pill>
      {showProject && (
        <Pill size="sm">
          {row.project.label}
        </Pill>
      )}
      <Select
        aria-label={`Priority of ${ref}`}
        size="sm"
        value={String(row.priority)}
        onChange={(e: ChangeEvent<HTMLSelectElement>) => onPriority(row.id, Number(e.target.value))}
        items={bands.map((b) => ({ value: String(b.priority), label: b.name }))}
      />
      {statusPill(row.status)}
      {row.today && (
        <Pill size="sm" tone="positive" dot>
          Today
        </Pill>
      )}
      {row.tags.map((t) => (
        <Caption key={t} as="span" tone="muted">
          #{t}
        </Caption>
      ))}
    </SortableItem>
  );
}

function Queue() {
  const view = Route.useLoaderData();
  const router = useRouter();
  const navigate = useNavigate({ from: "/queue" });
  const { snap } = useRealtime();
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A push whose itemsStamp differs from the one this view was read at means an item changed somewhere (this
  // page, the CLI, another tab): re-read. Seeded from the loader, so a change between the read and the socket's
  // first push is not taken as the baseline.
  const seen = useRef(view.itemsStamp);
  useEffect(() => {
    seen.current = view.itemsStamp;
  }, [view.itemsStamp]);
  const stamp = snap?.itemsStamp;
  useEffect(() => {
    if (stamp === undefined || stamp === seen.current) return;
    seen.current = stamp;
    void router.invalidate();
  }, [stamp, router]);

  const write = async (run: () => Promise<unknown>) => {
    setError(null);
    try {
      await run();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    await router.invalidate();
  };

  const bandOf = new Map(view.bands.map((b) => [b.name, b.priority]));
  const onReorder = (m: SortableMove) => {
    const move = m.target
      ? m.target.position === "before"
        ? { before: m.target.id }
        : { after: m.target.id }
      : { top: true as const, priority: m.section === undefined ? undefined : bandOf.get(m.section) };
    void write(() => setQueueOrder({ data: { id: m.id, move } }));
  };
  const onPriority = (id: string, priority: number) => void write(() => setPriority({ data: { id, priority } }));

  const count = view.bands.reduce((n, b) => n + b.items.length, 0);
  const whole = view.project === null;
  const scope = view.project?.label ?? view.group.label;
  return (
    <>
      <PageHeader
        title="Queue"
        description="A group's open items in the order they will be worked, next on top, grouped by priority. Pick a project to see only its queue."
      />
      <Stack>
        <Cluster gap="sm">
          <GroupPicker group={view.group} groups={view.groups} project={view.project} onChange={(search) => navigate({ search })} />
          <Caption as="span" tone="muted">
            {count} open{whole && view.group.projects.length > 1 ? ` across ${view.group.projects.length} projects` : ""}
          </Caption>
        </Cluster>
        {error && (
          <Callout tone="danger">
            Not saved: {error}
          </Callout>
        )}
        <SortableList label={`${scope} queue`} onReorder={onReorder}>
          {view.bands.map((b) => (
            <SortableSection key={b.name} id={b.name} title={b.name}>
              {b.items.map((r) => row(r, view.bands, setOpenId, onPriority, whole))}
            </SortableSection>
          ))}
        </SortableList>
      </Stack>
      <ItemDrawer
        itemId={openId}
        onClose={() => {
          setOpenId(null);
          void router.invalidate();
        }}
        getItem={getItem}
        transitionItem={transitionItem}
        setTodayRank={setTodayRank}
      />
    </>
  );
}
