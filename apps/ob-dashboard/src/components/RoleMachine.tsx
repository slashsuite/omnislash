import { Pill } from "@slashsuite/ui-react";
import type { CSSProperties } from "react";
import { useMemo } from "react";
import { type LaneKind, type LaneState, ROLE_NAMES, type RoleTicket, roleColour, roleLanes, STAGE_NAMES } from "../lib/role-machine.ts";

// OS-187: the role state machine with the tickets in flight on it. OS-261: drawn as persona swimlanes, one lane per
// persona (owner, muse, architect, builder, reviewer, sentinel, system) and one column per stage (Idea, Plan, Build,
// Ship, Done). Each state is a card in its persona's lane and its stage's column: its label, how many tickets sit on
// it, the first of them, and every move out of it in plain words, dotted in the colour of the persona that makes it.
// Moves are listed, not drawn as arrows: 39 arrows across seven lanes cross each other into a tangle.
//
// Wide (a container of 56rem or more) it is a grid, lanes down and stages across. Narrow (a phone) it is one column,
// stage by stage, each card under its persona's name. One tree for both: the grid places each part through CSS
// variables, so nothing is drawn twice. Pure: the tickets are the prop.

/** How many of a card's tickets are shown by ref; the rest are a `+N`. */
const SHOWN = 6;

const KIND_TAG: Readonly<Record<LaneKind, { text: string; tone: "neutral" | "warn" | "danger" } | null>> = {
  initial: { text: "start", tone: "neutral" },
  human: { text: "needs a person", tone: "warn" },
  terminal: { text: "end", tone: "neutral" },
  failed: { text: "end", tone: "danger" },
  normal: null,
};

/** The grid row and column a part takes on a wide container; on a narrow one it flows. */
const at = (row: number, column: number | string): CSSProperties => ({ "--lane-row": row, "--lane-col": column }) as CSSProperties;
const PLACED = "@4xl:[grid-row:var(--lane-row)] @4xl:[grid-column:var(--lane-col)]";

function Swatch({ className }: { className: string }) {
  return <span aria-hidden="true" className={`inline-block size-2 shrink-0 rounded-full bg-current ${className}`} />;
}

function StateCard({
  state,
  tickets,
  onOpenState,
  onOpenTicket,
}: {
  state: LaneState;
  tickets: readonly RoleTicket[];
  onOpenState?: ((state: string) => void) | undefined;
  onOpenTicket?: ((ref: string) => void) | undefined;
}) {
  const tag = KIND_TAG[state.kind];
  const titleId = `lane-state-${state.id}`;
  const shown = tickets.slice(0, SHOWN);
  const rest = tickets.length - shown.length;
  const title = (
    <span id={titleId} className="text-sm font-semibold text-slate-900">
      {state.label}
    </span>
  );
  return (
    <section
      aria-labelledby={titleId}
      data-state={state.id}
      className={`relative flex flex-col gap-1.5 overflow-hidden rounded-md border bg-white p-2 pt-2.5 ${state.kind === "failed" ? "border-red-300" : state.kind === "human" ? "border-amber-300" : "border-slate-200"}`}
    >
      <span aria-hidden="true" className={`absolute inset-x-0 top-0 h-1 bg-current ${roleColour(state.role)}`} />
      <div className="flex items-start justify-between gap-2">
        {onOpenState && tickets.length > 0 ? (
          <button type="button" onClick={() => onOpenState(state.id)} className="cursor-pointer text-left hover:underline" aria-label={`List the tickets in ${state.label}`}>
            {title}
          </button>
        ) : (
          title
        )}
        <Pill size="sm" tone={tickets.length > 0 ? "accent" : "neutral"}>
          <span aria-label={tickets.length === 1 ? "1 ticket" : `${tickets.length} tickets`}>{tickets.length}</span>
        </Pill>
      </div>
      {tag && (
        <span className="flex">
          <Pill size="sm" tone={tag.tone}>
            {tag.text}
          </Pill>
        </span>
      )}
      {tickets.length > 0 && (
        <ul aria-label={`Tickets in ${state.label}`} className="flex flex-wrap gap-1">
          {shown.map((t) => (
            <li key={t.ref}>
              <button
                type="button"
                title={`${t.ref} ${t.title}`}
                aria-label={`${t.ref} ${t.title}, in ${state.label}`}
                onClick={() => onOpenTicket?.(t.ref)}
                className="cursor-pointer rounded-full border border-slate-200 bg-slate-50 px-1.5 font-mono text-xs text-slate-700 hover:bg-slate-100"
              >
                {t.ref}
              </button>
            </li>
          ))}
          {rest > 0 && (
            <li>
              {onOpenState ? (
                <button type="button" onClick={() => onOpenState(state.id)} className="cursor-pointer px-1 text-xs text-slate-500 hover:underline" aria-label={`${rest} more in ${state.label}`}>
                  +{rest}
                </button>
              ) : (
                <span className="px-1 text-xs text-slate-500">+{rest}</span>
              )}
            </li>
          )}
        </ul>
      )}
      {state.moves.length > 0 && (
        <ul aria-label={`Moves from ${state.label}`} className="flex flex-col gap-1 border-t border-slate-100 pt-1.5">
          {state.moves.map((m) => (
            <li key={`${m.to}:${m.label}`} className="flex items-baseline gap-1.5 text-xs leading-snug">
              <Swatch className={`translate-y-[-1px] ${roleColour(m.actor)}`} />
              <span className="min-w-0">
                <span className="text-slate-700">{m.label}</span>
                <span className="sr-only">, by the {m.actor},</span>
                <span className="text-slate-500"> → {m.toLabel}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function RoleMachine({
  tickets,
  onOpenState,
  onOpenTicket,
}: {
  tickets: readonly RoleTicket[];
  /** A card's title, or its `+N`, was clicked: list that state's tickets. */
  onOpenState?: (state: string) => void;
  /** A ticket's ref on a card was clicked. */
  onOpenTicket?: (ref: string) => void;
}) {
  const { lanes, stages, cell } = useMemo(() => roleLanes(), []);
  const inState = useMemo(() => {
    const out = new Map<string, RoleTicket[]>();
    for (const t of tickets) out.set(t.state, [...(out.get(t.state) ?? []), t]);
    return out;
  }, [tickets]);
  return (
    <figure aria-label="Role state machine" className="@container m-0">
      <div className="grid gap-2 @4xl:grid-cols-[6.5rem_repeat(5,minmax(0,1fr))] @4xl:gap-x-2 @4xl:gap-y-0">
        {/* The lane bands and names: wide only, behind the cells of their row. */}
        {lanes.map((role, i) => (
          <div key={`band-${role}`} aria-hidden="true" style={at(i + 2, "1 / -1")} className={`hidden rounded-md @4xl:block ${PLACED} ${i % 2 === 0 ? "bg-slate-50" : ""}`} />
        ))}
        {lanes.map((role, i) => (
          <div key={`lane-${role}`} style={at(i + 2, 1)} className={`hidden items-start gap-1.5 px-2 py-3 text-sm font-semibold text-slate-700 @4xl:flex ${PLACED}`}>
            <Swatch className={`translate-y-1.5 ${roleColour(role)}`} />
            {ROLE_NAMES[role]}
          </div>
        ))}
        {stages.map((stage, c) => (
          <div key={stage} role="group" aria-label={`${STAGE_NAMES[stage]} stage`} className="contents">
            <h3 style={at(1, c + 2)} className={`mt-3 border-b border-slate-200 pb-1 text-xs font-semibold tracking-wide text-slate-500 uppercase @4xl:mt-0 ${PLACED}`}>
              {STAGE_NAMES[stage]}
            </h3>
            {lanes.map((role, r) => {
              const states = cell(role, stage);
              if (states.length === 0) return null;
              return (
                <div key={`${role}-${stage}`} style={at(r + 2, c + 2)} className={`flex flex-col gap-1.5 @4xl:py-2 ${PLACED}`}>
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 @4xl:hidden">
                    <Swatch className={roleColour(role)} />
                    {ROLE_NAMES[role]}
                  </span>
                  {states.map((s) => (
                    <StateCard key={s.id} state={s} tickets={inState.get(s.id) ?? []} onOpenState={onOpenState} onOpenTicket={onOpenTicket} />
                  ))}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </figure>
  );
}
