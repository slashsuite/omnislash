import { describe, expect, test } from "bun:test";
import { bindV2Hooks, locationPaths, type FactoryHooks, type V2SetupCtx } from "../../../apps/cli/opencode/lib/v2-setup.ts";

function mockCtx(opts: {
  events?: Array<{ type?: string; data?: { sessionID?: string } }>;
}): {
  ctx: V2SetupCtx;
  prompts: unknown[];
  afters: unknown[];
  contexts: Array<{ sessionID?: string; system: Array<{ type: string; text?: string }> }>;
  eventsDrained: Promise<void>;
} {
  const prompts: unknown[] = [];
  const afters: unknown[] = [];
  const contexts: Array<{ sessionID?: string; system: Array<{ type: string; text?: string }> }> = [];
  let drain!: () => void;
  const eventsDrained = new Promise<void>((resolve) => {
    drain = resolve;
  });
  const ctx: V2SetupCtx = {
    location: { directory: "/wt/801", project: { directory: "/wt/801" } },
    event: {
      subscribe: async function* () {
        try {
          for (const event of opts.events ?? []) yield event;
        } finally {
          drain();
        }
      },
    },
    session: {
      hook: async (name, cb) => {
        if (name === "prompt") prompts.push(await cb({ sessionID: "s1", model: {}, system: [] }));
        if (name === "context") {
          const event = { sessionID: "s1", model: { id: "m" }, system: [{ type: "text", text: "existing" }] };
          await cb(event);
          contexts.push(event);
        }
      },
    },
    tool: {
      hook: async (name, cb) => {
        if (name === "execute.after") {
          afters.push(
            await cb({
              tool: "bash",
              sessionID: "s1",
              id: "c1",
              input: { command: "ob memory add x" },
              status: "completed",
              result: { metadata: { title: "ob memory add" } },
            }),
          );
        }
      },
    },
  };
  return { ctx, prompts, afters, contexts, eventsDrained };
}

describe("V2 setup adapter maps factory hooks (801)", () => {
  test("locationPaths prefers project.directory as worktree", () => {
    expect(
      locationPaths({
        location: { directory: "/wt/801", project: { directory: "/dev/omnibus" } },
        event: { subscribe: async function* () {} },
        session: { hook: async () => {} },
        tool: { hook: async () => {} },
      }),
    ).toEqual({ directory: "/wt/801", worktree: "/dev/omnibus" });
  });

  test("session.idle data.sessionID becomes factory event.properties.sessionID", async () => {
    const seen: string[] = [];
    const hooks: FactoryHooks = {
      event: async (payload) => {
        if (payload.event.type === "session.idle") seen.push(payload.event.properties?.sessionID ?? "");
      },
    };
    const { ctx, eventsDrained } = mockCtx({ events: [{ type: "session.idle", data: { sessionID: "s-idle" } }] });
    const cleanup = await bindV2Hooks(ctx, hooks);
    await eventsDrained;
    expect(seen).toEqual(["s-idle"]);
    await cleanup();
  });

  test("context prepends { type: text } in front of existing system", async () => {
    const hooks: FactoryHooks = {
      "experimental.chat.system.transform": async (_input, output) => {
        output.system.unshift("soul");
      },
    };
    const { ctx, contexts } = mockCtx({});
    await bindV2Hooks(ctx, hooks);
    expect(contexts[0]?.system).toEqual([
      { type: "text", text: "soul" },
      { type: "text", text: "existing" },
    ]);
  });

  test("tool.execute.after maps input to args and metadata.title", async () => {
    const seen: Array<{ args?: Record<string, unknown>; title?: string; sessionID?: string }> = [];
    const hooks: FactoryHooks = {
      "tool.execute.after": async (input, output) => {
        seen.push({ args: input.args, title: output.title, sessionID: input.sessionID });
      },
    };
    const { ctx } = mockCtx({});
    await bindV2Hooks(ctx, hooks);
    expect(seen).toEqual([{ args: { command: "ob memory add x" }, title: "ob memory add", sessionID: "s1" }]);
  });

  test("cleanup calls dispose", async () => {
    let disposed = false;
    const hooks: FactoryHooks = {
      dispose: async () => {
        disposed = true;
      },
    };
    const { ctx } = mockCtx({});
    const cleanup = await bindV2Hooks(ctx, hooks);
    await cleanup();
    expect(disposed).toBe(true);
  });
});
