import { Pill } from "@slashsuite/ui-react";
import { fmtClock } from "../lib/localTime.ts";
import { useRealtime } from "../lib/useRealtime.ts";

// A global "live" indicator (083): green when the WS sidecar is connected, showing the last push
// time. Proves the realtime feed is flowing on every page.
export function LiveBadge() {
  const { snap, connected } = useRealtime();
  const at = snap?.at ? fmtClock(snap.at) : null;
  return (
    <Pill tone={connected ? "positive" : "neutral"} dot round>
      {connected ? (at ? `live · ${at}` : "live") : "offline"}
    </Pill>
  );
}
