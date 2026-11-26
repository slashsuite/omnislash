/** Thin V2 setup adapter. Maps OpenCode 2.0.x hooks onto the V1-shaped factory objects. */

export type FactoryHooks = {
  dispose?: () => Promise<void> | void;
  event?: (payload: {
    event: { type?: string; properties?: { sessionID?: string } };
  }) => Promise<void> | void;
  "chat.message"?: () => Promise<void> | void;
  "tool.execute.after"?: (
    input: { tool: string; sessionID?: string; callID?: string; args?: Record<string, unknown> },
    output: { title?: string },
  ) => Promise<void> | void;
  "experimental.chat.system.transform"?: (
    input: { sessionID?: string; model: unknown },
    output: { system: string[] },
  ) => Promise<void> | void;
};

type V2Event = {
  type?: string;
  data?: { sessionID?: string };
  properties?: { sessionID?: string };
};

type V2ToolAfter = {
  tool: string;
  sessionID?: string;
  id?: string;
  input?: unknown;
  status?: string;
  result?: { metadata?: Record<string, unknown> };
};

type V2ContextEvent = {
  sessionID?: string;
  model: unknown;
  system: Array<{ type: string; text?: string }>;
};

export type V2SetupCtx = {
  location: {
    directory: string;
    project?: { directory?: string; canonical?: string };
  };
  event: {
    subscribe: (opts?: { signal?: AbortSignal }) => AsyncIterable<V2Event>;
  };
  session: {
    hook: (name: string, cb: (event: V2ContextEvent) => unknown) => Promise<unknown>;
  };
  tool: {
    hook: (name: string, cb: (event: V2ToolAfter) => unknown) => Promise<unknown>;
  };
};

function sessionIDOf(event: V2Event): string | undefined {
  return event.data?.sessionID ?? event.properties?.sessionID;
}

function toolArgs(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

/** Leaves a key out rather than setting it to undefined (exactOptionalPropertyTypes). */
function defined<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });
}

function toolTitle(event: V2ToolAfter): string | undefined {
  const title = event.result?.metadata?.title;
  return typeof title === "string" ? title : undefined;
}

export async function bindV2Hooks(ctx: V2SetupCtx, hooks: FactoryHooks): Promise<() => Promise<void>> {
  const controller = new AbortController();

  if (hooks.event) {
    const onEvent = hooks.event;
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            await onEvent({
              event: { ...defined("type", event.type), properties: defined("sessionID", sessionIDOf(event)) },
            });
          } catch (err) {
            // One handler failure must not end the subscription: later events (session.idle) still need stamping.
            console.error(`ob plugin: event handler failed on ${event.type ?? "event"}: ${(err as Error).message}`);
          }
        }
      } catch {
        // aborted or stream closed
      }
    })();
  }

  if (hooks["chat.message"]) {
    const onMessage = hooks["chat.message"];
    await ctx.session.hook("prompt", () => onMessage());
  }

  if (hooks["tool.execute.after"]) {
    const onAfter = hooks["tool.execute.after"];
    await ctx.tool.hook("execute.after", (event) =>
      onAfter(
        {
          tool: event.tool,
          ...defined("sessionID", event.sessionID),
          ...defined("callID", event.id),
          args: toolArgs(event.input),
        },
        defined("title", toolTitle(event)),
      ),
    );
  }

  if (hooks["experimental.chat.system.transform"]) {
    const onTransform = hooks["experimental.chat.system.transform"];
    await ctx.session.hook("context", async (event) => {
      const output = { system: [] as string[] };
      await onTransform({ ...defined("sessionID", event.sessionID), model: event.model }, output);
      for (let i = output.system.length - 1; i >= 0; i--) {
        event.system.unshift({ type: "text", text: output.system[i]! });
      }
    });
  }

  return async () => {
    controller.abort();
    await hooks.dispose?.();
  };
}

export function locationPaths(ctx: V2SetupCtx): { directory: string; worktree: string } {
  return {
    directory: ctx.location.directory,
    worktree: ctx.location.project?.directory ?? ctx.location.directory,
  };
}
