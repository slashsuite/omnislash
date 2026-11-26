import { bindV2Hooks, type V2SetupCtx } from "../lib/v2-setup.ts";

const SKILL_HEADER =
  "After a non-trivial turn, file a reusable procedure with `ob add` (no spinoff). Body is the SKILL.md. Frontmatter marker agent_created: true; name starts with ob-. Git skills/ stay pinned. Idle is a backstop only (no second model).";

const IDLE_BACKSTOP =
  "No skill ticket filed this session. If the last turn produced a reusable procedure, run `ob add` with the SKILL.md as --body (frontmatter agent_created: true, name ob-<kebab>). No spinoff.";

type ToolAfterInput = {
  tool: string;
  sessionID?: string;
  callID?: string;
  args?: Record<string, unknown>;
};

function sessionKey(id: string | undefined): string {
  return id ?? "";
}

function isSkillAdd(command: string): boolean {
  return /\bob\s+add\b/.test(command) && /agent_created:\s*true/.test(command);
}

function skillSystemBlock(idleBackstop: boolean): string {
  const parts = [SKILL_HEADER];
  if (idleBackstop) parts.push(IDLE_BACKSTOP);
  return parts.join("\n\n");
}

export function createSkillHooks() {
  const filed = new Set<string>();
  const backstop = new Set<string>();
  let disposed = false;

  return {
    dispose: async () => {
      disposed = true;
    },
    event: async (payload: { event: { type?: string; properties?: { sessionID?: string } } }) => {
      if (disposed) return;
      if (payload.event.type !== "session.idle") return;
      const id = sessionKey(payload.event.properties?.sessionID);
      if (!filed.has(id)) backstop.add(id);
    },
    "tool.execute.after": async (toolInput: ToolAfterInput, _output?: unknown) => {
      if (disposed) return;
      const command = typeof toolInput.args?.command === "string" ? toolInput.args.command : "";
      if (!isSkillAdd(command)) return;
      const id = sessionKey(toolInput.sessionID);
      filed.add(id);
      backstop.delete(id);
    },
    "experimental.chat.system.transform": async (
      transformInput: { sessionID?: string; model: unknown },
      output: { system: string[] },
    ) => {
      if (disposed) return;
      const id = sessionKey(transformInput.sessionID);
      const idle = backstop.has(id);
      if (idle) backstop.delete(id);
      output.system.unshift(skillSystemBlock(idle));
    },
  };
}

export default {
  id: "ob-skills",
  async setup(ctx: V2SetupCtx) {
    return bindV2Hooks(ctx, createSkillHooks());
  },
};
