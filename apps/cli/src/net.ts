import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "./errors.ts";
import { warn } from "./output.ts";
import { settingFor } from "./settings.ts";
import type { Store } from "./db/store.ts";
import { defaultMasterKey, getSecret, hasSecret, KNOWN_SECRETS, type MasterKey } from "./secrets.ts";

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Resolve a named secret's raw string value: the encrypted store first, then — during the transition
 * off token files — the legacy `*_path` file (with a one-line "run `ob secret import`" nudge on
 * stderr). Clean AppError when neither is present. The Keychain master key is only fetched when the
 * store actually holds the secret, so an all-files setup never touches the Keychain.
 */
// --- the token readers (337) -------------------------------------------------------------------------
//
// The readers go through the store, because the encrypted store they consult first is a table in the
// database. Nothing about the secrets themselves changed: the same master key from the same Keychain (or
// the same 0600 file on the server), the same ciphertext columns, the same legacy `*_path` file fallback
// with the same nudge, and no value logged or printed on any path.
//
// The ladder is stated once in these small functions rather than inline in each reader:
//   knownSecretSpec            -- which secret this is, and the refusal when it is not one.
//   readLegacyTokenFile        -- the file fallback, its nudge, and the AppError when the file is absent.
//   githubTokenFromToolingOrEnv / readGithubTokenFile -- GitHub's extra middle rungs (gh CLI, then env)
//                                 and its own file fallback, which differ from the generic ladder.

/** Which known secret this name refers to. Shared by both forms of readManagedSecret. */
function knownSecretSpec(name: string) {
  const spec = KNOWN_SECRETS[name];
  if (!spec) throw new AppError(`unknown secret '${name}'`);
  return spec;
}

/** The legacy token-FILE fallback, with its transition nudge. Shared by both forms. */
function readLegacyTokenFile(
  name: string,
  spec: { pathSetting: string; label: string },
  path: string,
): string {
  try {
    const text = readFileSync(expandHome(path), "utf8").trim();
    warn(`${name}: still a file (${path}) — run \`ob secret import\` to move it into the encrypted store`);
    return text;
  } catch {
    throw new AppError(
      `cannot read ${spec.label} at ${path} (run \`ob secret set ${name}\`, or set config ${spec.pathSetting} to a token file)`,
    );
  }
}

/** GitHub's middle rungs: the already-authed gh CLI, then GITHUB_TOKEN/GH_TOKEN. Null when neither. */
async function githubTokenFromToolingOrEnv(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    if (out.length > 0) return out;
  } catch {
    /* fall through */
  }
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
}

/** GitHub's own legacy file fallback (its error names `gh auth login`, not `ob secret set`). */
function readGithubTokenFile(path: string): string {
  try {
    const token = readFileSync(expandHome(path), "utf8").trim();
    warn(`github: still a file (${path}) — run \`ob secret import\` to move it into the encrypted store`);
    return token;
  } catch {
    throw new AppError("no GitHub token (run `gh auth login`, set GITHUB_TOKEN, or `ob secret set github`)");
  }
}

export async function readManagedSecret(
  store: Store,
  name: string,
  masterKey: MasterKey = defaultMasterKey(),
): Promise<string> {
  const spec = knownSecretSpec(name);
  if (await hasSecret(store, name)) {
    const v = await getSecret(store, name, masterKey.get());
    if (v !== null) return v;
  }
  return readLegacyTokenFile(name, spec, await settingFor(store, spec.pathSetting));
}

/** The `github` token from the encrypted store only, or null when none is stored. */
export async function storedGithubToken(store: Store, masterKey?: MasterKey): Promise<string | null> {
  if (!(await hasSecret(store, "github"))) return null;
  return getSecret(store, "github", (masterKey ?? defaultMasterKey()).get());
}

export async function readGithubToken(store: Store, masterKey?: MasterKey): Promise<string> {
  const stored = await storedGithubToken(store, masterKey);
  if (stored !== null) return stored;
  const middle = await githubTokenFromToolingOrEnv();
  if (middle !== null) return middle;
  return readGithubTokenFile(await settingFor(store, "github_key_path"));
}

interface GqlResult<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function gql<T>(
  endpoint: string,
  headers: Record<string, string>,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const maxAttempts = 5;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ query, variables }),
      });
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 2 ** attempt * 1000;
        await Bun.sleep(waitMs);
        continue;
      }
      const json = (await res.json()) as GqlResult<T>;
      if (json.errors && json.errors.length > 0) {
        throw new AppError(`GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`);
      }
      if (!res.ok || !json.data) {
        throw new AppError(`request failed (${res.status})`);
      }
      return json.data;
    } catch (err) {
      lastErr = err;
      if (err instanceof AppError && err.message.startsWith("GraphQL error")) throw err;
      await Bun.sleep(2 ** attempt * 500);
    }
  }
  throw new AppError(`network request failed after ${maxAttempts} attempts: ${String(lastErr)}`);
}

export function githubGql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  return gql<T>(
    "https://api.github.com/graphql",
    { authorization: `bearer ${token}`, "user-agent": "omnislash-ob" },
    query,
    variables,
  );
}
