#!/usr/bin/env bash
# Open the full OpenCode TUI as the `architect` agent in the current directory.
#
# `ob project wire <project>` installs this file as `.opencode/architect-tui.sh` in a checkout. Run it from
# the checkout root. The OpenCode TUI has no --agent flag, so the script creates the session through the
# API, switches it to the architect agent, pins the model, injects the ob-architect skill (the skill sets
# disable-model-invocation, so the model cannot load it itself) and only then opens the TUI on that
# session. A stamp that does not take exits non-zero: it never opens a TUI that is silently the wrong
# agent or model.
#
# OB_ARCHITECT_MODEL picks the model as <provider>/<model id>.
set -euo pipefail

# Resume attaches to the existing session instead of creating a second one.
if [ "${1:-}" = "--session" ] && [ -n "${2:-}" ]; then
  exec opencode --session "$2" --auto
fi

model_spec="${OB_ARCHITECT_MODEL:-opencode-go/deepseek-v4.1-flash}"
provider="${model_spec%%/*}"
model="${model_spec#*/}"
if [ -z "$provider" ] || [ -z "$model" ] || [ "$provider" = "$model_spec" ]; then
  echo "architect-tui: OB_ARCHITECT_MODEL must be <provider>/<model id>, got '${model_spec}'" >&2
  exit 1
fi

payload=$(python3 -c 'import json, os; print(json.dumps({"title": "architect", "location": {"directory": os.getcwd()}}))')
resp=$(opencode api post /api/session --data "$payload")
id=$(printf '%s' "$resp" | python3 -c 'import json, sys; print(json.load(sys.stdin)["data"]["id"])')
if [ -z "$id" ]; then
  echo "architect-tui: could not create session" >&2
  exit 1
fi
opencode api post "/api/session/${id}/agent" --data '{"agent":"architect"}' >/dev/null
# With no model, --auto falls back to OpenCode's free default, which does not hold the architect role.
# Pin the model before the TUI starts.
model_payload=$(MODEL="$model" PROVIDER="$provider" python3 -c 'import json, os; print(json.dumps({"model": {"id": os.environ["MODEL"], "providerID": os.environ["PROVIDER"]}}))')
opencode api post "/api/session/${id}/model" --data "$model_payload" >/dev/null
agent=$(opencode api get "/api/session/${id}" | python3 -c 'import json, sys; d=json.load(sys.stdin)["data"]; print(d.get("agent") or ""); print((d.get("model") or {}).get("id") or "")')
got_agent=$(printf '%s\n' "$agent" | sed -n '1p')
got_model=$(printf '%s\n' "$agent" | sed -n '2p')
if [ "$got_agent" != "architect" ]; then
  echo "architect-tui: session ${id} agent is '${got_agent}', want architect" >&2
  exit 1
fi
if [ "$got_model" != "$model" ]; then
  echo "architect-tui: session ${id} model is '${got_model}', want ${model}" >&2
  exit 1
fi
opencode api post "/api/experimental/session/${id}/skill" --data '{"id":"ob-architect"}' >/dev/null
# One session in this terminal: do not inherit the per-directory tab strip.
export OPENCODE_CLI_CONFIG_CONTENT='{"tabs":{"enabled":false}}'
exec opencode --session "$id" --auto
