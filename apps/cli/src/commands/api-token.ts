// OS-178: `ob api-token add|list|revoke`, the scoped API tokens in ~/.ob_api_tokens.json.
//
// LOCAL ONLY: it writes a file on THIS machine (the API host, which reads it per request) and never goes over
// HTTP. `add` prints the new token ONCE, to stdout, and stores only its sha256; `list` never prints a hash.
import type { Ctx } from "../ctx.ts";
import { AppError, UsageError } from "../errors.ts";
import { print } from "../output.ts";
import {
  TokensFileError,
  newToken,
  readTokensForEdit,
  sha256Hex,
  tokensPath,
  writeTokens,
  type ScopedTokenEntry,
} from "../api/scoped-tokens.ts";
import { OB_API_SCOPABLE_FAMILIES } from "../api/contract.ts";

const USAGE = ["ob api-token add <user> --project <p>[,<p>...]", "ob api-token list [--json]", "ob api-token revoke <user>"].join("\n");

function read(path: string): ScopedTokenEntry[] {
  try {
    return readTokensForEdit(path);
  } catch (e) {
    if (e instanceof TokensFileError) throw new AppError(e.message);
    throw e;
  }
}

function userArg(ctx: Ctx): string {
  const user = ctx.args[1]?.trim();
  if (!user) throw new UsageError(`a user is required\n${USAGE}`);
  if (user === "admin") throw new UsageError("'admin' is the ~/.ob_api_token holder and cannot be a scoped user");
  return user;
}

export async function cmdApiToken(ctx: Ctx): Promise<void> {
  const sub = ctx.args[0];
  const path = tokensPath();
  if (sub === "add") {
    const user = userArg(ctx);
    const projects = (ctx.flags.project ?? "").split(",").map((p) => p.trim()).filter((p) => p.length > 0);
    if (projects.length === 0) throw new UsageError(`--project is required\n${USAGE}`);
    const entries = read(path);
    if (entries.some((e) => e.user === user)) throw new AppError(`'${user}' already has a token; revoke it first (ob api-token revoke ${user})`);
    const token = newToken();
    writeTokens([...entries, { user, sha256: sha256Hex(token), projects, families: [...OB_API_SCOPABLE_FAMILIES] }], path);
    // The one time the token is ever shown. stdout only, so it can be piped straight to its user.
    print(token);
    return;
  }
  if (sub === "list") {
    const rows = read(path).map((e) => ({ user: e.user, projects: e.projects, families: e.families }));
    if (ctx.flags.json) {
      print(JSON.stringify({ path, tokens: rows }, null, 2));
      return;
    }
    if (rows.length === 0) {
      print(`no scoped API tokens (${path})`);
      return;
    }
    for (const r of rows) print(`${r.user}  projects: ${r.projects.join(", ")}  families: ${r.families.join(", ")}`);
    return;
  }
  if (sub === "revoke") {
    const user = userArg(ctx);
    const entries = read(path);
    const kept = entries.filter((e) => e.user !== user);
    if (kept.length === entries.length) throw new AppError(`no scoped API token for '${user}'`);
    writeTokens(kept, path);
    print(`revoked ${user}`);
    return;
  }
  throw new UsageError(sub ? `unknown api-token subcommand '${sub}'\n${USAGE}` : USAGE);
}
