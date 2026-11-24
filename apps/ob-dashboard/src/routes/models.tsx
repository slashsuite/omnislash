import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, type ChangeEvent } from "react";
import { Button, Callout, Caption, Card, Checkbox, Cluster, Input, PageHeader, Pill, Select, Stack, Text, TextLink } from "@hackcove/ui-react";
import { checkedAtText, creditState } from "../lib/credit.ts";
import { getModels, saveModels, type ModelsOp, type ModelsPage, type ModelsView } from "../server/models.ts";

// OS-146: the Models page over OS-145's model routing. It edits the server's `model_routes` setting, the one
// `ob models` prints and changes, so a chain saved here is what every machine launches on (unless that machine's
// own models file overrides it). Every value is checked on the server by model-routes.ts; the page sends what was
// typed and shows the refusal word for word. OS-23: the OpenCode Go credit state (from omnibus's retired Reviewers
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
  if (error) return <Text tone="danger" role="alert">Not saved: {error}</Text>;
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

function RouteRow({ row, view, send }: { row: ModelsView["routes"][number]; view: ModelsView; send: Send }) {
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
        <Cluster gap="xs">
          <Input
            aria-label={`Models for ${row.route}`}
            value={chain}
            placeholder="model, fallback model"
            spellCheck={false}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              setChain(e.target.value);
              s.clear();
            }}
            size="sm"
            width="fill"
          />
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
          <Button size="sm" disabled={s.busy} onClick={() => s.run({ op: "setRoute", profile, route: row.route, chain, ...(effort ? { effort } : {}) })}>
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

function ReaderRow({ leg, model, profile, send }: { leg: string; model: string; profile: string; send: Send }) {
  const [value, setValue] = useDraft(model);
  const s = useSend(send);
  return (
    <Card size="sm" title={leg} titleStyle="name">
      <Stack gap="xs">
        <Cluster gap="xs">
          <Input
            aria-label={`Model for reader ${leg}`}
            value={value}
            spellCheck={false}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              setValue(e.target.value);
              s.clear();
            }}
            size="sm"
            width="fill"
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

function AddReader({ profile, send }: { profile: string; send: Send }) {
  const [leg, setLeg] = useState("");
  const [model, setModel] = useState("");
  const s = useSend(send);
  return (
    <Stack gap="xs">
      <Cluster gap="xs">
        <Input aria-label="New reader name" placeholder="name" value={leg} spellCheck={false} onChange={(e: ChangeEvent<HTMLInputElement>) => setLeg(e.target.value)} size="sm" width="sm" />
        <Input aria-label="New reader model" placeholder="model id" value={model} spellCheck={false} onChange={(e: ChangeEvent<HTMLInputElement>) => setModel(e.target.value)} size="sm" width="fill" />
        <Button size="sm" variant="outline" disabled={s.busy} onClick={() => s.run({ op: "readerAdd", profile, leg, model })}>
          Add reader
        </Button>
      </Cluster>
      <Outcome error={s.error} saved={s.saved} />
    </Stack>
  );
}

function TierRow({ tier, view, send }: { tier: string; view: ModelsView; send: Send }) {
  const s = useSend(send);
  const legs = view.review.value.tiers[tier as keyof ModelsView["review"]["value"]["tiers"]] ?? [];
  return (
    <Stack gap="xs">
      <Cluster gap="sm">
        <Text as="span" strong>{tier}</Text>
        {Object.keys(view.review.value.readers).map((leg) => (
          <Checkbox
            key={leg}
            size="sm"
            label={`${leg} on ${tier}`}
            checked={legs.includes(leg)}
            disabled={s.busy}
            onChange={(checked) =>
              s.run({ op: "readerTier", profile: view.profile, tier, legs: checked ? [...legs, leg] : legs.filter((l) => l !== leg) })
            }
          />
        ))}
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
        <Profiles key={`${view.profile}:${view.active.name}:${view.profiles.join(",")}`} view={view} send={send} />
        <Card title={`Routes in ${view.profile}`} count={view.routes.length}>
          <Stack gap="sm">
            {view.routes.map((r) => (
              <RouteRow key={`${view.profile}:${r.route}`} row={r} view={view} send={send} />
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
              <ReaderRow key={`${view.profile}:${leg}`} leg={leg} model={r.model} profile={view.profile} send={send} />
            ))}
            <AddReader key={`${view.profile}:${Object.keys(review.value.readers).join(",")}`} profile={view.profile} send={send} />
            {view.tiers.map((t) => (
              <TierRow key={t} tier={t} view={view} send={send} />
            ))}
          </Stack>
        </Card>
      </Stack>
    </>
  );
}
