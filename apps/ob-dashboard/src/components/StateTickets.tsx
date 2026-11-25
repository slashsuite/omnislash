import { Card, Caption, Disclosure, ListRow, Pill, Stack } from "@slashsuite/ui-react";
import type { StateMachineState } from "@slashsuite/ui-react";
import type { MachineRow } from "../lib/machine.ts";

// OS-241: every ticket on the Machine page, listed by the state it sits in. One disclosure per state that holds any,
// in the machine's own order, its count on the summary; open, it lists every ticket by ref and title, and a ticket
// opens in the item drawer. The page opens a state's list when its box in the diagram is clicked. Pure: the open
// states are the page's.

/** The id the page scrolls to when a box is clicked: one per state. */
export const stateListId = (state: string) => `state-tickets-${state}`;

/** The prefix uislash's diagram puts on a state box's `data-measure` (useFlowLayout's nodeKey). */
const BOX_KEY = "n:";

/** The state whose box a click landed in, or null for a click on a button or a link (a linked dot) or outside any box. */
export function boxOfClick(target: EventTarget | null): string | null {
  if (!(target instanceof Element) || target.closest("a, button")) return null;
  const key = target.closest(`[data-measure^="${BOX_KEY}"]`)?.getAttribute("data-measure");
  return key ? key.slice(BOX_KEY.length) : null;
}

export function StateTickets({
  states,
  tickets,
  open,
  onToggle,
  onOpenTicket,
}: {
  states: readonly StateMachineState[];
  tickets: readonly MachineRow[];
  open: ReadonlySet<string>;
  onToggle: (state: string, open: boolean) => void;
  onOpenTicket: (itemId: string) => void;
}) {
  const inState = new Map<string, MachineRow[]>();
  for (const t of tickets) inState.set(t.state, [...(inState.get(t.state) ?? []), t]);
  const held = states.filter((s) => inState.has(s.id));
  // A ticket whose state the machine does not know still shows, as the diagram's "Not in any state" box does.
  const known = new Set(states.map((s) => s.id));
  const stray = tickets.filter((t) => !known.has(t.state));
  const groups = [
    ...held.map((s) => ({ id: s.id, label: s.label, items: inState.get(s.id) ?? [] })),
    ...(stray.length > 0 ? [{ id: "unplaced", label: "Not in any state", items: stray }] : []),
  ];
  if (groups.length === 0) return <Caption tone="muted">No tickets in any state.</Caption>;
  return (
    <Stack gap="sm" aria-label="Tickets by state">
      {groups.map((g) => (
        <div key={g.id} id={stateListId(g.id)}>
          <Disclosure
            bordered
            open={open.has(g.id)}
            onOpenChange={(next) => onToggle(g.id, next)}
            summary={
              <span className="flex items-center gap-2">
                {g.label}
                <Pill size="sm" tone="accent">
                  {g.items.length}
                </Pill>
              </span>
            }
          >
            <Card flush>
              <Stack divided>
                {g.items.map((t) => (
                  <ListRow
                    key={`${t.id ?? "open"}:${t.ref}`}
                    size="sm"
                    onClick={() => onOpenTicket(t.itemId)}
                  >
                    {t.ref} {t.title}
                  </ListRow>
                ))}
              </Stack>
            </Card>
          </Disclosure>
        </div>
      ))}
    </Stack>
  );
}
