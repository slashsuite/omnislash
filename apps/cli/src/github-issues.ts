import { defineSeam } from "./test-seams.ts";
import type { Database } from "bun:sqlite";
import { githubGql, readGithubToken } from "./net.ts";
import { AppError } from "./errors.ts";
import { asStore, type Store } from "./db/store.ts";

// GitHub-issue plumbing for the opt-in "ticket = a GitHub issue" flow (221 phase 3). `ob add --issue`
// creates a `wayfinder:task` issue on `wayfinder_repo` (the source of truth) + a local mirror item;
// `ob spinoff #<n>` resolves a GitHub issue number → its title/body for the brief. Both go through the
// in-process GraphQL client (net.ts) so they're testable behind an injectable seam — NO live network in
// tests: `__setCreateIssue` / `__setFetchIssue` swap fakes in.

export interface CreatedIssue {
  number: number;
  url: string;
}
export interface FetchedIssue {
  number: number;
  title: string;
  body: string | null;
  url: string;
}
export interface CreateIssueInput {
  repo: string; // owner/name
  title: string;
  body?: string | null;
  labels: string[];
}

/**
 * Labels for a wayfinder task issue: `wayfinder:task` always; `map:<name>` when a map is given;
 * `exec:<mode>` when an exec mode is given. Pure. (These labels already exist in the repo.)
 */
export function issueLabels(opts: { map?: string | null; exec?: string | null }): string[] {
  const labels = ["wayfinder:task"];
  if (opts.map) labels.push(`map:${opts.map}`);
  if (opts.exec) labels.push(`exec:${opts.exec}`);
  return labels;
}

/**
 * Parse a spinoff ref as a GitHub issue number — ONLY the explicit `#<n>` form (e.g. `#35`). A bare
 * number stays the existing ob/wayfinder ref path (used verbatim as `ticket_ref`), so `#` is the
 * disambiguator that opts a ref into GitHub-issue resolution. Returns the number, or null. Pure.
 */
export function parseIssueRef(ref: string): number | null {
  const m = ref.trim().match(/^#(\d+)$/);
  return m ? Number(m[1]) : null;
}

/** A branch name derived from an issue: `<number>-<slug(title)>`, or just `<number>` when the title is empty. Pure. */
export function deriveBranch(number: number, title: string, max = 40): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, max)
    .replace(/-+$/, "");
  return slug ? `${number}-${slug}` : String(number);
}

/** Split an `owner/name` repo string; throws a clean AppError on a malformed value. Pure. */
export function splitRepo(repo: string): { owner: string; name: string } {
  const [owner, name, ...rest] = repo.split("/");
  if (!owner || !name || rest.length > 0) throw new AppError(`invalid repo '${repo}' (expected owner/name)`);
  return { owner, name };
}

// --- live GraphQL implementations (behind the seam) ------------------------

const REPO_LABELS_QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    id
    labels(first: 100) { nodes { id name } }
  }
}`;

const CREATE_ISSUE_MUTATION = `
mutation($repositoryId: ID!, $title: String!, $body: String, $labelIds: [ID!]) {
  createIssue(input: { repositoryId: $repositoryId, title: $title, body: $body, labelIds: $labelIds }) {
    issue { number url }
  }
}`;

interface RepoLabelsResp {
  repository: { id: string; labels: { nodes: Array<{ id: string; name: string } | null> } } | null;
}
interface CreateIssueResp {
  createIssue: { issue: { number: number; url: string } | null } | null;
}

async function createIssueLive(db: Database | Store, input: CreateIssueInput): Promise<CreatedIssue> {
  const token = await readGithubToken(asStore(db));
  const { owner, name } = splitRepo(input.repo);
  const repoResp = await githubGql<RepoLabelsResp>(token, REPO_LABELS_QUERY, { owner, name });
  const repository = repoResp.repository;
  if (!repository) throw new AppError(`repo '${input.repo}' not found`);
  const byName = new Map(
    (repository.labels.nodes ?? []).filter((l): l is { id: string; name: string } => !!l).map((l) => [l.name, l.id]),
  );
  const labelIds: string[] = [];
  for (const l of input.labels) {
    const id = byName.get(l);
    if (id) labelIds.push(id);
    else throw new AppError(`label '${l}' does not exist in ${input.repo} (create it first)`);
  }
  const resp = await githubGql<CreateIssueResp>(token, CREATE_ISSUE_MUTATION, {
    repositoryId: repository.id,
    title: input.title,
    body: input.body ?? "",
    labelIds,
  });
  const issue = resp.createIssue?.issue;
  if (!issue) throw new AppError("createIssue returned no issue");
  return { number: issue.number, url: issue.url };
}

const ISSUE_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) { number title url body }
  }
}`;

interface IssueResp {
  repository: { issue: { number: number; title: string | null; url: string | null; body: string | null } | null } | null;
}

async function fetchIssueLive(db: Database | Store, repo: string, number: number): Promise<FetchedIssue> {
  const token = await readGithubToken(asStore(db));
  const { owner, name } = splitRepo(repo);
  const resp = await githubGql<IssueResp>(token, ISSUE_QUERY, { owner, name, number });
  const issue = resp.repository?.issue;
  if (!issue) throw new AppError(`issue #${number} not found in ${repo}`);
  return { number: issue.number, title: issue.title ?? "", body: issue.body ?? null, url: issue.url ?? "" };
}

// --- close / reopen (77: landing an item closes its GitHub issue too) ------
//
// Two round trips because GraphQL's closeIssue/reopenIssue take a node id, not a number: resolve the
// issue (id + state + url), then mutate. Resolving first also means a NO-OP is reported honestly: an
// issue that is already closed is never mutated and comes back `already: true`.

const ISSUE_NODE_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) { id number url state title }
  }
}`;

const CLOSE_ISSUE_MUTATION = `
mutation($issueId: ID!) {
  closeIssue(input: { issueId: $issueId }) { issue { number url state } }
}`;

const REOPEN_ISSUE_MUTATION = `
mutation($issueId: ID!) {
  reopenIssue(input: { issueId: $issueId }) { issue { number url state } }
}`;

interface IssueNodeResp {
  repository: {
    issue: { id: string; number: number; url: string | null; state: string | null; title: string | null } | null;
  } | null;
}
interface MutateIssueResp {
  closeIssue?: { issue: { number: number; url: string | null; state: string | null } | null } | null;
  reopenIssue?: { issue: { number: number; url: string | null; state: string | null } | null } | null;
}

/** The outcome of a close/reopen: what the issue now is, and whether it was ALREADY in that state. */
export interface IssueStateChange {
  number: number;
  url: string;
  title: string;
  state: "open" | "closed";
  already: boolean;
}

/**
 * The GraphQL transport, injectable so the DECIDING code below (the already-in-that-state no-op, the
 * not-found refusal, which mutation gets sent) is testable without a token or a network. Only the
 * transport is swapped; the decisions under test are the real ones.
 */
export type GithubGqlFn = <T>(token: string, query: string, variables: Record<string, unknown>) => Promise<T>;
const githubGqlSeam = defineSeam<GithubGqlFn>("github-issues.githubGql", githubGql);

/** Test seam: swap the GraphQL transport; returns a restore fn. */
export function __setGithubGql(fn: GithubGqlFn): () => void {
  return githubGqlSeam.set(fn);
}

async function setIssueStateLive(
  db: Database | Store,
  repo: string,
  number: number,
  want: "closed" | "open",
): Promise<IssueStateChange> {
  const token = await readGithubToken(asStore(db));
  const { owner, name } = splitRepo(repo);
  const found = await githubGqlSeam.get()<IssueNodeResp>(token, ISSUE_NODE_QUERY, { owner, name, number });
  const issue = found.repository?.issue;
  if (!issue) throw new AppError(`issue #${number} not found in ${repo}`);
  const current = (issue.state ?? "").toUpperCase() === "CLOSED" ? "closed" : "open";
  const base = { number: issue.number, url: issue.url ?? "", title: issue.title ?? "" };
  if (current === want) return { ...base, state: want, already: true };
  const mutation = want === "closed" ? CLOSE_ISSUE_MUTATION : REOPEN_ISSUE_MUTATION;
  const resp = await githubGqlSeam.get()<MutateIssueResp>(token, mutation, { issueId: issue.id });
  const after = resp.closeIssue?.issue ?? resp.reopenIssue?.issue;
  if (!after) throw new AppError(`${want === "closed" ? "closeIssue" : "reopenIssue"} returned no issue`);
  return { ...base, url: after.url ?? base.url, state: want, already: false };
}

// --- injectable seams (tests swap in fakes; no live network) ---------------

export type CreateIssueFn = (db: Database | Store, input: CreateIssueInput) => Promise<CreatedIssue>;
export type FetchIssueFn = (db: Database | Store, repo: string, number: number) => Promise<FetchedIssue>;
export type SetIssueStateFn = (
  db: Database | Store,
  repo: string,
  number: number,
  want: "closed" | "open",
) => Promise<IssueStateChange>;

const createIssueSeam = defineSeam<CreateIssueFn>("github-issues.createIssue", createIssueLive);
const fetchIssueSeam = defineSeam<FetchIssueFn>("github-issues.fetchIssue", fetchIssueLive);
const setIssueStateSeam = defineSeam<SetIssueStateFn>("github-issues.setIssueState", setIssueStateLive);

export function createIssue(db: Database | Store, input: CreateIssueInput): Promise<CreatedIssue> {
  return createIssueSeam.get()(db, input);
}
export function fetchIssue(db: Database | Store, repo: string, number: number): Promise<FetchedIssue> {
  return fetchIssueSeam.get()(db, repo, number);
}

/** Test seam: swap the create-issue client; returns a restore fn. */
export function __setCreateIssue(fn: CreateIssueFn): () => void {
  return createIssueSeam.set(fn);
}
/** Test seam: swap the fetch-issue client; returns a restore fn. */
export function __setFetchIssue(fn: FetchIssueFn): () => void {
  return fetchIssueSeam.set(fn);
}

/** Close a GitHub issue (no-op + `already: true` when it is already closed). */
export function closeIssue(db: Database | Store, repo: string, number: number): Promise<IssueStateChange> {
  return setIssueStateSeam.get()(db, repo, number, "closed");
}
/** Reopen a GitHub issue (no-op + `already: true` when it is already open). */
export function reopenIssue(db: Database | Store, repo: string, number: number): Promise<IssueStateChange> {
  return setIssueStateSeam.get()(db, repo, number, "open");
}
/** Test seam: swap the close/reopen client; returns a restore fn. NOTHING in tests may reach GitHub. */
export function __setSetIssueState(fn: SetIssueStateFn): () => void {
  return setIssueStateSeam.set(fn);
}
