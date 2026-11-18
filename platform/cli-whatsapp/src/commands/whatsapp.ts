import type { Ctx } from "../../../../apps/cli/src/ctx.ts";
import { AppError, UsageError } from "../../../../apps/cli/src/errors.ts";
import { resetStore, sqliteStoreFor } from "../../../../apps/cli/src/db/store.ts";
import { print, warn } from "../../../../apps/cli/src/output.ts";
import {
  recentWhatsapp,
  searchWhatsapp,
  syncWhatsapp,
  type WhatsappHit,
} from "../ingest/whatsapp.ts";
import { getConfig, setConfig, deleteConfig } from "../../../../apps/cli/src/config.ts";
import {
  sendWhatsapp,
  readBridgeToken,
  describeAttachment,
  sendGateLines,
  partialSendMessage,
  BridgeOutcomeUnknown,
  SendMaybeAlreadyGone,
  type WhatsappAttachment,
} from "../whatsapp/send.ts";
import { flushSentry, reportError, startSentry } from "../../../../apps/cli/src/sentry/report.ts";
import {
  bridgeConfig,
  startBridge,
  runBridge,
  stopBridge,
  bridgeStatus,
  bridgeStatusHeadline,
  type BridgeHealth,
  type LogVerdict,
} from "../whatsapp/bridge.ts";
import {
  applyChatPref,
  getChatPref,
  listHiddenChats,
  listFavoriteChats,
} from "../whatsapp/prefs.ts";
import { prefetchFavoriteStatusMedia } from "../whatsapp/status.ts";

/** who — the mapped person is resolved at read; here we show the raw sender jid (chat name for context). */
export function renderHits(hits: WhatsappHit[]): string {
  return hits
    .map((h) => {
      const who = h.is_from_me ? "me" : (h.sender_jid ?? "-");
      const chat = h.chat_name ?? h.chat_jid;
      const text = (h.content ?? "").replace(/\s+/g, " ").slice(0, 80);
      return `${h.ts ?? ""}\t${chat}\t${who}\t${text}`;
    })
    .join("\n");
}

/** Read a single line from stdin (the interactive y/N confirm). Empty on EOF. */
function readStdinLine(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const onData = (chunk: Buffer) => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.pause();
      resolve(chunk.toString("utf8").trim());
    };
    const onEnd = () => {
      stdin.off("data", onData);
      resolve("");
    };
    stdin.resume();
    stdin.once("data", onData);
    stdin.once("end", onEnd);
  });
}

/** The bridge's health + remedy for annotating a zero-result sync; null when it cannot be read at all. */
async function syncBridgeHealth(
  ctx: Ctx,
): Promise<{ health: BridgeHealth; log: LogVerdict; remedy: string | null } | null> {
  try {
    const store = ctx.store ?? sqliteStoreFor(ctx.db);
    const res = await bridgeStatus(await bridgeConfig(store), {
      readToken: () => readBridgeToken(store),
    });
    return { health: res.health, log: res.log, remedy: res.remedy };
  } catch {
    return null;
  }
}

/**
 * Say WHICH kind of zero a zero-result sync was, and never call a logged-out bridge a quiet one. The log
 * verdict is read as well as the health (1347) so a refused CLIENT does not get the re-pairing sentence:
 * a pairing that cannot help is worse than no advice, because it costs the working session.
 */
export function zeroResultNote(bridge: { health: BridgeHealth; log?: LogVerdict; remedy: string | null }): string {
  if (bridge.health === "healthy") return "0 new with the bridge authenticated - nothing new to read";
  if (bridge.health === "unauthenticated") {
    const why =
      bridge.log === "client-outdated"
        ? "the bridge's WhatsApp CLIENT IS OUTDATED (405) - nothing can be ingested until the bridge is rebuilt"
        : "the bridge is NOT AUTHENTICATED - nothing can be ingested until it is re-linked";
    return `0 new because ${why}${bridge.remedy ? ` (${bridge.remedy})` : ""}`;
  }
  if (bridge.health === "down") return "0 new with the bridge DOWN - nothing is ingesting at all";
  return "0 new, but the bridge's session state could not be read - this zero proves nothing either way";
}

/**
 * THE human gate for `ob whatsapp send`, on the terminal the human is at, over the API as much as locally
 * (OB-1809). Prints the EXACT recipient + full message (+ every file), then asks. `--yes` is the one way past.
 */
export async function confirmWhatsappSend(
  flags: Pick<Ctx["flags"], "yes">,
  to: string,
  body: string | undefined,
  files: WhatsappAttachment[],
): Promise<boolean> {
  for (const line of sendGateLines(to, body, files)) warn(line);
  let confirmed = flags.yes === true;
  if (!confirmed) {
    warn(`Send this message? [y/N] `);
    const answer = (await readStdinLine()).toLowerCase();
    confirmed = answer === "y" || answer === "yes";
  }
  if (!confirmed) warn("aborted — nothing sent");
  return confirmed;
}

export async function cmdWhatsapp(ctx: Ctx): Promise<void> {
  const sub = ctx.args[0] ?? "sync";
  const store = ctx.store ?? sqliteStoreFor(ctx.db);

  if (sub === "send") {
    const to = ctx.flags.to;
    const body = ctx.flags.body;
    if (!to) throw new UsageError("whatsapp send requires --to <jid>");
    const files = (ctx.flags.file ?? []).map(describeAttachment);
    if (!body && files.length === 0) {
      throw new UsageError("whatsapp send requires --body <text> (or --file <path>)");
    }

    if (!(await confirmWhatsappSend(ctx.flags, to, body, files))) return;

    // Only a human's explicit "yes" reaches this line; that is what sets confirm: true.
    if (files.length === 0) {
      const res = await sendWhatsapp(store, { to, body: body ?? "", confirm: true, resend: ctx.flags.resend === true });
      if (ctx.mode === "json") print(JSON.stringify(res, null, 2));
      else print(`sent to ${res.to}`);
      return;
    }
    // One message per file, in order; the caption rides on the first. A failure stops the rest, and the
    // error names what went and prints the command for the rest (OB-1909), so nothing is silently half-sent.
    const results = [];
    for (const [i, file] of files.entries()) {
      try {
        results.push(
          await sendWhatsapp(store, {
            to,
            body: i === 0 ? (body ?? "") : "",
            file,
            confirm: true,
            resend: ctx.flags.resend === true,
          }),
        );
      } catch (e) {
        // OB-1909: a may-already-have-gone refusal is shown as it is; after a file went, with what went.
        if (e instanceof SendMaybeAlreadyGone && results.length === 0) throw e;
        const typed = ctx.flags.file ?? [];
        throw new AppError(
          `${(e as Error).message}\n${partialSendMessage({ to, body, files: typed, sent: results.length, failedUnknown: e instanceof BridgeOutcomeUnknown || e instanceof SendMaybeAlreadyGone })}`,
        );
      }
    }
    if (ctx.mode === "json") print(JSON.stringify(results, null, 2));
    else print(`sent ${results.length} file${results.length === 1 ? "" : "s"} to ${to}`);
    return;
  }

  if (sub === "bridge") {
    const action = ctx.args[1] ?? "status";
    const cfg = await bridgeConfig(store);

    if (action === "start") {
      const res = startBridge(cfg);
      if (ctx.mode === "json") {
        print(JSON.stringify(res, null, 2));
        return;
      }
      if (res.alreadyRunning) {
        print(`whatsapp bridge already running on :${res.port} (pid ${res.pid}) — log: ${res.logPath}`);
      } else {
        print(`whatsapp bridge started on :${res.port} (pid ${res.pid})`);
        print(`log: ${res.logPath} — tail it to scan the QR on first link / re-auth`);
      }
      return;
    }

    if (action === "run") {
      // Foreground, daemon-supervised mode (like `ob web`): spawn the bridge and BLOCK on it so launchd's
      // KeepAlive supervises the real long-running process — crash → immediate restart, no polling.
      // ob 1657: errors from this supervisor go to Sentry (project omnislash-whatsapp-bridge) when its DSN
      // secret exists; off otherwise. Read BEFORE the pool is closed below. Only what THIS process throws is
      // reported: the Go child's output, and any message or number in it, never passes through here.
      await startSentry("bridge", async () => store);
      let outcome: ReturnType<typeof runBridge>;
      try {
        outcome = runBridge(cfg);
      } catch (e) {
        reportError(e, { daemon: "whatsapp-bridge" });
        await flushSentry();
        throw e;
      }
      if (outcome.alreadyRunning) {
        // A relaunch onto a healthy bridge is this command SUCCEEDING at what it is for, so it exits 0
        // (221). The human still gets told what was found; only the job-health table's reading changed.
        print(outcome.note);
        if (store.kind === "postgres") await resetStore();
        return;
      }
      const handle = outcome;
      print(`whatsapp bridge running on :${cfg.port} (pid ${handle.pid})`);
      print(`log: ${cfg.logPath} — tail it to scan the QR on first link / re-auth`);
      // ob 401: the Go child holds the WhatsApp session; this process only waits. Keeping the
      // Postgres pool open for days is how the database host ran out of slots (10 idle backends from the
      // Aug-18 supervisor, still there 2026-08-24). Close it now; cli.ts reopens for job-health.
      if (store.kind === "postgres") await resetStore();
      const stop = () => handle.kill("SIGTERM");
      process.on("SIGTERM", stop);
      process.on("SIGINT", stop);
      const code = await handle.exited; // stays alive exactly as long as the bridge does
      // ob 1657: a bridge that dies is a non-zero exit, not a throw. 130 and 143 are SIGINT and SIGTERM: our own stop,
      // or `systemctl stop` signalling the whole cgroup, which is a stop and not a crash. (137, the OOM killer, is reported.)
      if (code !== 0 && code !== 130 && code !== 143) {
        reportError(new Error(`whatsapp bridge exited with code ${code}`), { daemon: "whatsapp-bridge" });
        await flushSentry();
      }
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
      // Through ctx, not process.exitCode: index.ts exits with what run() returns, so a process.exitCode
      // set here was silently discarded and a bridge that crashed recorded a SUCCESS (221).
      ctx.exit = code ?? 0;
      return;
    }

    if (action === "stop") {
      const res = stopBridge(cfg);
      if (ctx.mode === "json") print(JSON.stringify(res, null, 2));
      else print(res.stopped ? `whatsapp bridge stopped (pid ${res.pid})` : "whatsapp bridge not running");
      return;
    }

    if (action === "status") {
      const res = await bridgeStatus(cfg, { readToken: () => readBridgeToken(store) });
      if (ctx.mode === "json") {
        print(JSON.stringify(res, null, 2));
        return;
      }
      // Four distinct answers, never three (#119): down · up-but-not-authenticated · healthy · unknown.
      // Every line is followed by the signals it was derived from, each stating what it does not prove,
      // so nobody has to guess whether "healthy" was read or inferred.
      print(bridgeStatusHeadline(res));
      for (const signal of res.signals) print(`  · ${signal}`);
      if (res.remedy) print(`  → ${res.remedy}`);
      return;
    }

    throw new UsageError(`unknown whatsapp bridge action '${action}' (start|run|stop|status)`);
  }

  if (sub === "sync") {
    const res = await syncWhatsapp(store, {
      backfill: ctx.flags.backfill === true,
      since: ctx.flags.since,
      days: ctx.flags.days != null ? Number(ctx.flags.days) : undefined,
      max: ctx.flags.max != null ? Number(ctx.flags.max) : undefined,
    });
    await prefetchFavoriteStatusMedia(store);
    // A zero-result sync is ambiguous: nothing new, or nothing CAN arrive because the bridge is logged
    // out (#119 - "0 new" every 60s for hours while the pairing was dead). Only that ambiguous case pays
    // for the health read, and a failed read leaves the count reported without a claim either way.
    const health = res.ingested === 0 ? await syncBridgeHealth(ctx) : null;
    if (ctx.mode === "json") {
      print(JSON.stringify(health ? { ...res, bridge: health } : res, null, 2));
      return;
    }
    print(
      `whatsapp sync — ${res.messages} read, ${res.ingested} new (cursor ${res.cursor ?? "-"})${res.capped ? " [capped: re-run to continue]" : ""}`,
    );
    // Said out loud rather than silently: a fold CHANGED stored rows, and a repair nobody is told about
    // is indistinguishable from data going missing on its own (312).
    if (res.folded > 0) print(`  · folded ${res.folded} @lid duplicate row(s) onto their canonical chat`);
    if (health) print(`  · ${zeroResultNote(health)}`);
    return;
  }

  if (sub === "search") {
    const query = ctx.args.slice(1).join(" ");
    if (!query) throw new UsageError("whatsapp search requires a <query>");
    const hits = await searchWhatsapp(store, query, ctx.flags.limit ? Number(ctx.flags.limit) : 20);
    if (ctx.mode === "json") print(JSON.stringify(hits, null, 2));
    else print(renderHits(hits));
    return;
  }

  if (sub === "recent") {
    const limit = ctx.flags.limit ? Number(ctx.flags.limit) : 20;
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new UsageError("whatsapp recent --limit must be a positive number");
    }
    const hits = await recentWhatsapp(store, { since: ctx.flags.since, limit });
    if (ctx.mode === "json") print(JSON.stringify(hits, null, 2));
    else if (ctx.mode === "quiet") print(hits.map((h) => h.id).join("\n"));
    else print(hits.length === 0 ? "no whatsapp messages" : renderHits(hits));
    return;
  }

  // Global self-bio (#28): the "about me" woven into EVERY suggested reply (self_bio config). `bio` with
  // no text shows it; `bio <text…>` sets it; `bio --clear` removes it. Trusted, applies to all chats.
  if (sub === "bio") {
    if (ctx.flags.clear === true) {
      await deleteConfig(ctx.db, "self_bio");
      if (ctx.mode === "json") print(JSON.stringify({ self_bio: "" }, null, 2));
      else print("self-bio cleared");
      return;
    }
    const text = ctx.args.slice(1).join(" ").trim();
    if (!text) {
      // Show the current bio (falls back to the empty DEFAULT when unset).
      const current = (await getConfig(ctx.db, "self_bio")) ?? "";
      if (ctx.mode === "json") print(JSON.stringify({ self_bio: current }, null, 2));
      else print(current || "(no self-bio set — `ob whatsapp bio \"<about you>\"` to set one)");
      return;
    }
    await setConfig(ctx.db, "self_bio", text);
    if (ctx.mode === "json") print(JSON.stringify({ self_bio: text }, null, 2));
    else print(`self-bio set:\n${text}`);
    return;
  }

  // Per-chat preferences (169): hide/show a chat + disable/enable AI-suggested replies. Keyed by the
  // CANONICAL chat_jid (an @lid and its phone-jid share one pref). Scripting/tests convenience — the
  // dashboard has the interactive toggles.
  if (
    sub === "hide" ||
    sub === "show" ||
    sub === "ai-off" ||
    sub === "ai-on" ||
    sub === "favorite" ||
    sub === "unfavorite"
  ) {
    if (sub === "show" && ctx.args.length === 1) {
      // `whatsapp show` with no jid → list the hidden chats (canonical jids).
      const hidden = await listHiddenChats(store);
      if (ctx.mode === "json") print(JSON.stringify(hidden, null, 2));
      else print(hidden.length === 0 ? "no hidden chats" : hidden.join("\n"));
      return;
    }
    if (sub === "favorite" && ctx.args.length === 1) {
      // `whatsapp favorite` with no jid → list the favourited chats (canonical jids).
      const favs = await listFavoriteChats(store);
      if (ctx.mode === "json") print(JSON.stringify(favs, null, 2));
      else print(favs.length === 0 ? "no favourite chats" : favs.join("\n"));
      return;
    }
    const jid = ctx.args[1];
    if (!jid) throw new UsageError(`whatsapp ${sub} requires a <chat_jid>`);
    await applyChatPref(store, jid, sub);
    const pref = await getChatPref(store, jid);
    if (ctx.mode === "json") print(JSON.stringify({ chat_jid: jid, ...pref }, null, 2));
    else
      print(
        `${jid} — ${pref.hidden ? "hidden" : "visible"}, AI ${pref.ai_disabled ? "off" : "on"}, ${pref.favorite ? "favourite" : "not favourite"}`,
      );
    return;
  }

  throw new UsageError(
    `unknown whatsapp subcommand '${sub}' (sync|search|recent|send|bridge|bio|hide|show|ai-off|ai-on|favorite|unfavorite)`,
  );
}
