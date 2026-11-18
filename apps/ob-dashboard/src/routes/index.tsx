import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@hackcove/ui-react";

// OB-2205: a placeholder (ObFrame, from __root.tsx, gives it the header and the page width). The OB pages (items, agents, alerts, tokens, reviewers) move here in the later
// OB-2199 steps.
export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return (
    <PageHeader title="OB" description="The OB dashboard. Its pages move here next." />
  );
}
