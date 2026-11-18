import { Button, Callout } from "@hackcove/ui-react";
import { useEffect, useState } from "react";
import { registerServiceWorker } from "../lib/registerSw.ts";

// ob 1693: registers the service worker once the page is on the client, and shows an "update available"
// notice above the home indicator when a deploy has replaced it. Reloading picks up the new build.
// `appName` is the app the notice names (OB-2205): the personal dashboard is "OmniSlash", the OB dashboard "OB".
export function PwaRegister({ appName = "OmniSlash" }: { appName?: string } = {}) {
  const [updated, setUpdated] = useState(false);
  useEffect(() => {
    registerServiceWorker(() => setUpdated(true));
  }, []);
  if (!updated) return null;
  return (
    <div className="fixed inset-x-0 bottom-0 z-50 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <Callout
        tone="info"
        title="Update available"
        actions={<Button size="sm" onClick={() => window.location.reload()}>Reload</Button>}
      >
        {appName} was updated. Reload to use the new version.
      </Callout>
    </div>
  );
}
