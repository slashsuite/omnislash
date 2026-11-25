import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, type ChangeEvent, type ReactNode } from "react";
import {
  Button,
  Callout,
  Caption,
  Card,
  Checkbox,
  Cluster,
  Input,
  PageHeader,
  Pill,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Text,
  TextLink,
} from "@slashsuite/ui-react";
import { ModelChain, ModelSelect } from "../components/ModelChain.tsx";
import { checkedAtText, creditState } from "../lib/credit.ts";
import { chainOf } from "../lib/favorites.ts";
import { draftsOf, mergeNext, rangesOf, splitAt, type DraftRange } from "../lib/ranges.ts";
import { getModels, saveModels, type ModelsOp, type ModelsPage, type ModelsView } from "../server/models.ts";

// OS-146: the Models page over OS-145's model routing. It edits the server's `model_routes` setting, the one
// `ob models` prints and changes, so a chain saved here is what every machine launches on (unless that machine's
// own models file overrides it). Every value is checked on the server by model-routes.ts; the page sends what was
// picked and shows the refusal word for word. OS-240: every model is picked from Jacobus's T3 favourites (stored by
// `ob models sync-favorites`), never typed, so a chain saves as <provider>:<model> ids. OS-23: the OpenCode Go credit state (from omnibus's retired Reviewers
// page) sits above the review readers, since the paid readers run on that account.

type ModelsSearch = { profile?: string };

export const Route = createFileRoute("/models")({
  validateSearch: (s: Record<string, unknown>): ModelsSearch => (typeof s.profile === "string" && s.profile ? { profile: s.profile } : {}),
  loaderDeps: ({ search }) => ({ profile: search.profile }),
  loader: async ({ deps }) => await getModels({ data: { profile: deps.profile } }),
  component: Models,
});

type Send = (op: ModelsOp) => Promise<string | null>;

/** A save's outcome beside its button: "saved", or the server's refusal. */
function Outcome({ error, saved }: { error: string | null; saved: boolean }) {
  if (error)
    return (
      <div role="alert">
        <Text tone="danger">Not saved: {error}</Text>
      </div>
    );
  return saved ? <Caption as="span" tone="positive">saved</Caption> : null;
}

/** Run one op from a control, tracking its busy, saved and error state. */
function useSend(send: Send) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const run = async (op: ModelsOp) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    const err = await send(op);
    setBusy(false);
    if (err) setError(err);
    else setSaved(true);
    return err;
  };
  return { busy, error, saved, run, clear: () => setSaved(false) };
}

/** An editor's text that starts from `from` and follows it when a save changes it, while the row (and its
 *  "saved") stays mounted. Set during render, like the page's loader result. */
function useDraft(from: string) {
  const [draft, setDraft] = useState(from);
  const [seen, setSeen] = useState(from);
  if (seen !== from) {
    setSeen(from);
    setDraft(from);
  }
  return [draft, setDraft] as const;
}

function RouteRow({ row, view, favourites, send }: { row: ModelsView["routes"][number]; view: ModelsView; favourites: string[]; send: Send }) {
  // A local row's editor sets the server value underneath the override, so it starts from that, not the file's.
  const base = row.source === "local" ? row.server : { chain: row.chain, effort: row.effort };
  const [chain, setChain] = useDraft(base?.chain.join(", ") ?? "");
  const [effort, setEffort] = useDraft(base?.effort ?? "");
  const s = useSend(send);
  const profile = view.profile;

  return (
    // The card's title names it (a region named for the route), which is how a test or a screen reader finds the row.
    <Card size="sm" title={row.route} titleStyle="name" status={<Pill tone={row.source === "server" ? "info" : row.source === "local" ? "warn" : "neutral"}>{row.label}</Pill>}>
      <Stack gap="xs">
        <Caption tone="muted" mono>
          {row.chain.join(" → ")}
          {row.effort ? ` · ${row.effort}` : ""}
        </Caption>
        {row.source === "local" && (
          <Caption tone="muted">
            Overridden on this host by {view.file.path}. Edit that file on the host to change it there; the editor below sets the server value other
            machines use.
          </Caption>
        )}
        <ModelChain
          name={row.route}
          chain={chainOf(chain)}
          favourites={favourites}
          disabled={s.busy}
          onChange={(next) => {
            setChain(next.join(", "));
            s.clear();
          }}
        />
        <Cluster gap="xs">
          <Select
            aria-label={`Effort for ${row.route}`}
            value={effort}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => {
              setEffort(e.target.value);
              s.clear();
            }}
            size="sm"
            items={[{ value: "", label: "no effort" }, ...view.efforts.map((x) => ({ value: x, label: x }))]}
          />
          <Button size="sm" disabled={s.busy || chainOf(chain).length === 0} onClick={() => s.run({ op: "setRoute", profile, route: row.route, chain, ...(effort ? { effort } : {}) })}>
            {s.busy ? "Saving…" : `Save ${row.route}`}
          </Button>
          {row.server && (
            <Button size="sm" variant="outline" disabled={s.busy} onClick={() => s.run({ op: "unsetRoute", profile, route: row.route })}>
              {`Unset ${row.route}`}
            </Button>
          )}
        </Cluster>
        <Outcome error={s.error} saved={s.saved} />
      </Stack>
    </Card>
  );
}

function ReaderRow({
  leg,
  model,
  fallback,
  others,
  profile,
  favourites,
  send,
}: {
  leg: string;
  model: string;
  fallback: string | null;
  others: string[];
  profile: string;
  favourites: string[];
  send: Send;
}) {
  const [value, setValue] = useDraft(model);
  const s = useSend(send);
  return (
    <Card size="sm" title={leg} titleStyle="name">
      <Stack gap="xs">
        <Cluster gap="xs">
          <Select
            aria-label={`Fallback for reader ${leg}`}
            value={fallback ?? ""}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => s.run({ op: "readerFallback", profile, leg, fallback: e.target.value === "" ? null : e.target.value })}
            size="sm"
            items={[{ value: "", label: "no fallback" }, ...others.map((o) => ({ value: o, label: `falls back to ${o}` }))]}
          />
        </Cluster>
        <Cluster gap="xs">
          <ModelSelect
            label={`Model for reader ${leg}`}
            value={value}
            favourites={favourites}
            disabled={s.busy}
            onChange={(m) => {
              setValue(m);
              s.clear();
            }}
          />
          <Button size="sm" disabled={s.busy} onClick={() => s.run({ op: "readerAdd", profile, leg, model: value })}>
            {`Save reader ${leg}`}
          </Button>
          <Button size="sm" variant="outline" tone="danger" disabled={s.busy} onClick={() => s.run({ op: "readerRemove", profile, leg })}>
            {`Remove reader ${leg}`}
          </Button>
        </Cluster>
        <Outcome error={s.error} saved={s.saved} />
      </Stack>
    </Card>
  );
}

function AddReader({ profile, favourites, send }: { profile: string; favourites: string[]; send: Send }) {
  const [leg, setLeg] = useState("");
  const [model, setModel] = useState("");
  const s = useSend(send);
  return (
    <Stack gap="xs">
      <Cluster gap="xs">
        <Input aria-label="New reader name" placeholder="name" value={leg} spellCheck={false} onChange={(e: ChangeEvent<HTMLInputElement>) => setLeg(e.target.value)} size="sm" width="sm" />
        <ModelSelect label="New reader model" value={model} favourites={favourites} disabled={s.busy} onChange={setModel} />
        <Button size="sm" variant="outline" disabled={s.busy || !leg.trim() || !model} onClick={() => s.run({ op: "readerAdd", profile, leg, model })}>
          Add reader
        </Button>
      </Cluster>
      <Outcome error={s.error} saved={s.saved} />
    </Stack>
  );
}

/** Rows that start from the view's ranges and follow them when a save changes them, like `useDraft`. */
function useRows<T>(from: DraftRange<T>[]) {
  const key = JSON.stringify(from);
  const [rows, setRows] = useState(from);
  const [seen, setSeen] = useState(key);
  if (seen !== key) {
    setSeen(key);
    setRows(from);
  }
  return [rows, setRows] as const;
}

/**
 * A profile's whole set of ranges as a table (OS-176): each row's from and to, its value, a split at a number and
 * a merge with the next row. Nothing is sent until the save, which sends the whole set; the server refuses a gap
 * or an overlap with the CLI's own message.
 */
function RangeTable<T>({
  kind,
  rows,
  setRows,
  heads,
  cells,
  busy,
  edited,
}: {
  kind: string;
  rows: DraftRange<T>[];
  setRows: (rows: DraftRange<T>[]) => void;
  heads: string[];
  cells: (row: DraftRange<T>, i: number, set: (value: T) => void) => ReactNode;
  busy: boolean;
  /** A row changed: clears the last save's "saved" and any refusal of a split or merge. */
  edited: (refusal: string | null) => void;
}) {
  const [at, setAt] = useState<Record<number, string>>({});
  const change = (next: DraftRange<T>[] | string) => {
    if (typeof next === "string") return edited(next);
    // A split or merge moves the rows under their "Split at" boxes; an edit in place keeps them.
    if (next.length !== rows.length) setAt({});
    setRows(next);
    edited(null);
  };
  const put = (i: number, patch: Partial<DraftRange<T>>) => change(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <Table label={`${kind} ranges`}>
      <TableHead>
        <TableRow>
          <TableHeaderCell numeric>From</TableHeaderCell>
          <TableHeaderCell numeric>To</TableHeaderCell>
          {heads.map((h) => (
            <TableHeaderCell key={h}>{h}</TableHeaderCell>
          ))}
          <TableHeaderCell>Split or merge</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map((row, i) => {
          const name = `${kind} row ${i + 1}`;
          return (
            <TableRow key={i}>
              <TableCell numeric>
                <Input aria-label={`From, ${name}`} numeric inputMode="numeric" width="xs" value={row.from} disabled={busy} onChange={(e: ChangeEvent<HTMLInputElement>) => put(i, { from: e.target.value })} />
              </TableCell>
              <TableCell numeric>
                <Input aria-label={`To, ${name}`} numeric inputMode="numeric" width="xs" value={row.to} disabled={busy} onChange={(e: ChangeEvent<HTMLInputElement>) => put(i, { to: e.target.value })} />
              </TableCell>
              {cells(row, i, (value) => put(i, { value }))}
              <TableCell>
                <Cluster gap="xs">
                  <Input
                    aria-label={`Split ${name} at`}
                    placeholder="at"
                    numeric
                    inputMode="numeric"
                    width="xs"
                    value={at[i] ?? ""}
                    disabled={busy}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setAt({ ...at, [i]: e.target.value })}
                  />
                  <Button size="sm" variant="outline" disabled={busy || !at[i]?.trim()} onClick={() => change(splitAt(rows, i, at[i] ?? ""))}>
                    {`Split ${name}`}
                  </Button>
                  {i < rows.length - 1 && (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => change(mergeNext(rows, i))}>
                      {`Merge ${name} with next`}
                    </Button>
                  )}
                </Cluster>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** The refusal of a split, a merge or a box that is not a number, or the save's outcome. */
function useRangeSend(send: Send) {
  const s = useSend(send);
  const [refusal, setRefusal] = useState<string | null>(null);
  const edited = (r: string | null) => {
    setRefusal(r);
    s.clear();
  };
  return { ...s, refusal, edited, error: refusal ?? s.error, run: (op: ModelsOp) => (setRefusal(null), s.run(op)) };
}

type BuilderValue = { chain: string; effort: string };

/** The profile's builder ranges (OS-177): which model a builder launches on for each complexity score. */
function BuilderRanges({ view, favourites, send }: { view: ModelsView; favourites: string[]; send: Send }) {
  const bands = view.builder.bands;
  const [rows, setRows] = useRows(draftsOf(bands, (b): BuilderValue => ({ chain: b.chain.join(", "), effort: b.effort ?? "" })));
  const s = useRangeSend(send);
  const profile = view.profile;
  const save = () => {
    const ranges = rangesOf(rows);
    if (typeof ranges === "string") return s.edited(ranges);
    void s.run({
      op: "builderRanges",
      profile,
      ranges: ranges.map((r) => ({ from: r.from, to: r.to, chain: r.value.chain, ...(r.value.effort ? { effort: r.value.effort } : {}) })),
    });
  };
  const onServer = bands.some((b) => b.source === "server");
  return (
    <Card title={`Builder ranges in ${profile}`} count={bands.length}>
      <Stack gap="sm">
        <Caption tone="muted">
          The model a builder launches on, by the ticket's complexity (1-10). The ranges cover 1-10 with no gap or overlap.{" "}
          {onServer ? "Set on the server for this profile." : "The defaults; a save stores the whole set in this profile."}
          {view.builder.local && ` This host's models file (${view.file.path}) overrides them here; the editor sets the server value other machines use.`}
        </Caption>
        <RangeTable
          kind="builder"
          rows={rows}
          setRows={setRows}
          heads={["Models", "Effort"]}
          busy={s.busy}
          edited={s.edited}
          cells={(row, i, set) => (
            <>
              <TableCell>
                <ModelChain
                  name={`builder row ${i + 1}`}
                  chain={chainOf(row.value.chain)}
                  favourites={favourites}
                  disabled={s.busy}
                  onChange={(next) => set({ ...row.value, chain: next.join(", ") })}
                />
              </TableCell>
              <TableCell>
                <Select
                  aria-label={`Effort, builder row ${i + 1}`}
                  value={row.value.effort}
                  disabled={s.busy}
                  onChange={(e: ChangeEvent<HTMLSelectElement>) => set({ ...row.value, effort: e.target.value })}
                  items={[{ value: "", label: "no effort" }, ...view.efforts.map((x) => ({ value: x, label: x }))]}
                />
              </TableCell>
            </>
          )}
        />
        <Cluster gap="xs">
          <Button size="sm" disabled={s.busy} onClick={save}>
            {s.busy ? "Saving…" : "Save builder ranges"}
          </Button>
          {onServer && (
            <Button size="sm" variant="outline" disabled={s.busy} onClick={() => s.run({ op: "unsetRoute", profile, route: "builder" })}>
              Unset builder ranges
            </Button>
          )}
        </Cluster>
        <Outcome error={s.error} saved={s.saved} />
      </Stack>
    </Card>
  );
}

/** The review ranges (OS-175): which readers review a ticket, by its complexity. */
function ReviewRanges({ view, send }: { view: ModelsView; send: Send }) {
  const legs = Object.keys(view.review.value.readers);
  const [rows, setRows] = useRows(draftsOf(view.review.value.tiers, (r) => [...r.legs]));
  const s = useRangeSend(send);
  const save = () => {
    const ranges = rangesOf(rows);
    if (typeof ranges === "string") return s.edited(ranges);
    void s.run({ op: "readerRanges", profile: view.profile, ranges: ranges.map((r) => ({ from: r.from, to: r.to, legs: r.value })) });
  };
  return (
    <Stack gap="sm">
      <RangeTable
        kind="review"
        rows={rows}
        setRows={setRows}
        heads={["Readers"]}
        busy={s.busy}
        edited={s.edited}
        cells={(row, i, set) => (
          <TableCell>
            <Cluster gap="sm">
              {legs.map((leg) => (
                <Checkbox
                  key={leg}
                  size="sm"
                  label={`${leg} on review row ${i + 1}`}
                  checked={row.value.includes(leg)}
                  disabled={s.busy}
                  onChange={(checked) => set(checked ? [...row.value, leg] : row.value.filter((l) => l !== leg))}
                />
              ))}
            </Cluster>
          </TableCell>
        )}
      />
      <Cluster gap="xs">
        <Button size="sm" disabled={s.busy} onClick={save}>
          {s.busy ? "Saving…" : "Save review ranges"}
        </Button>
      </Cluster>
      <Outcome error={s.error} saved={s.saved} />
    </Stack>
  );
}

function Profiles({ view, send }: { view: ModelsView; send: Send }) {
  const navigate = useNavigate({ from: "/models" });
  const [next, setNext] = useState(view.profiles.find((p) => p !== view.active.name) ?? view.profiles[0] ?? "");
  const [fresh, setFresh] = useState("");
  const s = useSend(send);
  const active = view.active;

  return (
    <Card title="Profiles" count={view.profiles.length}>
      <Stack gap="sm">
        <Text>
          Active: <strong>{active.name ?? "none"}</strong>
          {active.source === "local" && ` (set by ${view.file.path} on this host${active.hiddenServer ? `; the server's is ${active.hiddenServer}` : ""})`}
          {active.undefinedProfile && " (no layer defines it, so only the defaults apply)"}
          {view.order.length > 1 && `. Tried in order: ${view.order.join(", ")}`}
        </Text>
        <Cluster gap="xs">
          <Select
            aria-label="Profile to make active"
            value={next}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => setNext(e.target.value)}
            size="sm"
            items={view.profiles.map((p) => ({ value: p, label: p }))}
          />
          <Button size="sm" disabled={s.busy || !next} onClick={async () => {
              // The page then shows the new active profile, so the URL drops any ?profile and a reload agrees.
              if (!(await s.run({ op: "use", profile: next }))) await navigate({ search: {} });
            }}>
            Make active for every machine
          </Button>
          <Outcome error={s.error} saved={s.saved} />
        </Cluster>
        <Cluster gap="xs">
          <Select
            aria-label="Profile to edit"
            value={view.profile}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => navigate({ search: { profile: e.target.value } })}
            size="sm"
            items={[...new Set([...view.profiles, view.profile])].map((p) => ({ value: p, label: `editing ${p}` }))}
          />
          <Input aria-label="New profile name" placeholder="new profile" value={fresh} spellCheck={false} onChange={(e: ChangeEvent<HTMLInputElement>) => setFresh(e.target.value)} size="sm" width="sm" />
          <Button size="sm" variant="outline" disabled={!fresh.trim()} onClick={() => navigate({ search: { profile: fresh.trim() } })}>
            Edit new profile
          </Button>
        </Cluster>
        <Caption tone="muted">A new profile is saved with its first route.</Caption>
      </Stack>
    </Card>
  );
}

/** The OpenCode Go credit: its status and when it was last checked. Checking it again is the Tokens page's job. */
function Credit({ credit }: { credit: ModelsPage["credit"] }) {
  const state = creditState(credit);
  return (
    <Callout tone={state.tone} title={`OpenCode Go credit: ${state.label}`}>
      {credit ? (
        <>
          Last checked <time dateTime={credit.checked_at}>{checkedAtText(credit.checked_at)}</time>
          {state.tone !== "positive" && credit.detail ? ` (${credit.detail})` : ""}. Check it again on the <TextLink href="/tokens">Tokens page</TextLink>.
        </>
      ) : (
        <>
          Check it on the <TextLink href="/tokens">Tokens page</TextLink> or with ob creds check opencode-go.
        </>
      )}
    </Callout>
  );
}

/** Where the dropdowns' options come from, and how to refresh them: they are synced from the T3 machine, never edited here. */
function Favourites({ favourites }: { favourites: ModelsPage["favourites"] }) {
  if (!favourites || favourites.models.length === 0)
    return (
      <Callout tone="warn" title="No T3 favourite models synced yet">
        The model dropdowns offer only what is stored now. Run ob models sync-favorites on the machine T3 Code runs on.
      </Callout>
    );
  return (
    <Caption tone="muted">
      Models are picked from your {favourites.models.length} T3 favourites, synced <time dateTime={favourites.synced_at}>{checkedAtText(favourites.synced_at)}</time>. Run ob models
      sync-favorites on the T3 machine after changing them.
    </Caption>
  );
}

function Models() {
  const loaded = Route.useLoaderData();
  const [page, setPage] = useState<ModelsPage>(loaded);
  // A new loader result (a reload, another ?profile) replaces what a save last returned, set during render.
  const [seen, setSeen] = useState(loaded);
  if (seen !== loaded) {
    setSeen(loaded);
    setPage(loaded);
  }
  const view = page.view;

  const send: Send = async (op) => {
    try {
      const res = await saveModels({ data: op });
      if (!res.ok) return res.error;
      setPage((p) => ({ ...p, view: res.view }));
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };

  const review = view.review;
  const favourites = page.favourites?.models ?? [];
  return (
    <>
      <PageHeader
        title="Models"
        description="Which model each route launches on, per profile: the server's model_routes, the same setting ob models shows and sets. A machine's own models file overrides it on that machine."
      />
      <Stack>
        {page.notes.map((n) => (
          <Callout key={n} tone="warn" title="Note">
            {n}
          </Callout>
        ))}
        <Caption tone="muted">
          This host's models file: {view.file.path} {view.file.present ? "(read; shown, never edited here)" : "(none)"}
        </Caption>
        <Favourites favourites={page.favourites} />
        <Profiles key={`${view.profile}:${view.active.name}:${view.profiles.join(",")}`} view={view} send={send} />
        <BuilderRanges key={view.profile} view={view} favourites={favourites} send={send} />
        <Card title={`Routes in ${view.profile}`} count={view.routes.length}>
          <Stack gap="sm">
            {view.routes.map((r) => (
              <RouteRow key={`${view.profile}:${r.route}`} row={r} view={view} favourites={favourites} send={send} />
            ))}
          </Stack>
        </Card>
        <Credit credit={page.credit} />
        <Card title={`Review readers in ${view.profile}`} count={Object.keys(review.value.readers).length}>
          <Stack gap="sm">
            <Caption tone="muted">
              {review.source === "server"
                ? "Set on the server for this profile."
                : review.source === "legacy"
                  ? "From the older review_readers setting; the first change here saves it into this profile."
                  : "The defaults; the first change here saves them into this profile."}
              {Object.keys(review.local).length > 0 && ` This host's models file overrides ${Object.keys(review.local).join(", ")}.`}
            </Caption>
            {Object.entries(review.value.readers).map(([leg, r]) => (
              <ReaderRow
                key={`${view.profile}:${leg}`}
                leg={leg}
                model={r.model}
                fallback={r.fallback ?? null}
                others={Object.keys(review.value.readers).filter((o) => o !== leg)}
                profile={view.profile}
                favourites={favourites}
                send={send}
              />
            ))}
            <AddReader key={`${view.profile}:${Object.keys(review.value.readers).join(",")}`} profile={view.profile} favourites={favourites} send={send} />
            <ReviewRanges key={view.profile} view={view} send={send} />
          </Stack>
        </Card>
      </Stack>
    </>
  );
}
