import { IconButton } from "@slashsuite/ui-react";
import { useRealtime } from "../../../../platform/dashboard-kit/src/lib/useRealtime.ts";

// (#45, moved to the OB dashboard by OB-2207) The header bell. The live un-acked alert count rides the
// realtime snapshot (Snapshot.alertCount), so it updates on every DB change and after an ack or snooze
// without a poll of its own. It links to /alerts. The count is 0 until the first push; the bell renders anyway.
export function AlertBell() {
  const { snap } = useRealtime();
  const count = snap?.alertCount ?? 0;
  const label = count > 0 ? `${count} alert${count === 1 ? "" : "s"} need attention` : "No alerts";
  return (
    <IconButton icon="bell" label={label} variant="ghost" count={count} href="/alerts" />
  );
}
