import type { Store } from "./db/store.ts";
import { settingFor } from "./settings.ts";

// ob 192: where `ob web` listens. The dashboard moves to the Proxmox box (ob 181) so it is always on
// and reachable from the phone, which needs a bind address; on a laptop nothing should change and
// nothing should be exposed by accident, so the default is LOOPBACK and every wider bind is explicit.
// Bun.serve with no `hostname` listens on ALL interfaces, so passing this value everywhere is what
// makes the default narrow rather than merely documented.

export const WEB_BIND_DEFAULT = "127.0.0.1";
export const WEB_BIND_ENV = "OMNISLASH_WEB_BIND";
export const WEB_PORT = 5050;

export interface WebBindSources {
  flag?: string | null | undefined;
  env?: string | null | undefined;
  configured?: string | null | undefined;
}

const clean = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};

/** `--bind` > OMNISLASH_WEB_BIND > the `web_bind` config row > loopback. Blank values never win. */
export function resolveWebBind(sources: WebBindSources = {}): string {
  return clean(sources.flag) ?? clean(sources.env) ?? clean(sources.configured) ?? WEB_BIND_DEFAULT;
}

/** The effective bind for a live invocation: the flag, the env var, then the DB's `web_bind` row. */
export async function webBindFor(store: Store, flag?: string | null): Promise<string> {
  return resolveWebBind({
    flag,
    env: process.env[WEB_BIND_ENV] ?? null,
    configured: await settingFor(store, "web_bind"),
  });
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** True when the bind reaches nothing but this machine. Everything else is reachable from the LAN. */
export function isLoopbackBind(host: string): boolean {
  return LOOPBACK.has(host.trim().toLowerCase());
}

/** A host to put in a printed URL: a wildcard bind is not a dialable address, so name loopback. */
export function displayHost(host: string): string {
  const h = host.trim();
  return h === "0.0.0.0" || h === "::" || h === "[::]" ? "localhost" : h;
}

/** The env the dashboard's own Bun server (apps/dashboard/serve.ts) reads for its listen address. */
export function webServeEnv(bind: string, port: number = WEB_PORT): { HOST: string; PORT: string } {
  return { HOST: bind, PORT: String(port) };
}
