import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { useEffect } from "react";

import appCss from "../styles.css?url";
import { appShellRootClassFor } from "@slashsuite/ui-react";
import { IosStatusBarBand } from "../../../../platform/dashboard-kit/src/components/IosStatusBarBand.tsx";
import { PwaRegister } from "../../../../platform/dashboard-kit/src/components/PwaRegister.tsx";
import { BUILD_COMMIT_META } from "../../../../platform/dashboard-kit/src/lib/buildCommitMeta.ts";
import { ObFrame } from "../components/ObFrame.tsx";
import { PWA_LINKS, PWA_META, VIEWPORT } from "../lib/pwa.ts";

export const Route = createRootRoute({
  head: () => ({
    meta: [{ charSet: "utf-8" }, { name: "viewport", content: VIEWPORT }, ...PWA_META, { title: "OmniSlash" }, BUILD_COMMIT_META],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "icon", type: "image/png", sizes: "32x32", href: "/favicon-32.png" },
      { rel: "icon", type: "image/png", sizes: "16x16", href: "/favicon-16.png" },
      { rel: "icon", href: "/favicon.ico", sizes: "any" },
      ...PWA_LINKS,
    ],
  }),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  // OS-146: the ready marker browser tests wait on (ob-ui-testing rule 2): set once React has hydrated.
  useEffect(() => {
    document.documentElement.dataset.hydrated = "true";
  }, []);
  return (
    <html lang="en" className={appShellRootClassFor("dark")}>
      <head>
        <HeadContent />
      </head>
      <body>
        <IosStatusBarBand />
        <ObFrame>{children}</ObFrame>
        <PwaRegister appName="OmniSlash" />
        <Scripts />
      </body>
    </html>
  );
}
