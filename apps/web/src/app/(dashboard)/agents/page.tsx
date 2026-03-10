import { Suspense } from "react";
import type { Metadata } from "next";
import { AgentsContent } from "./_components/agents-content";

export const metadata: Metadata = {
  title: "Agents",
};

export default function AgentsPage() {
  return (
    <div className="flex flex-1 flex-col gap-6 p-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
        <p className="text-muted-foreground text-sm">
          Manage agents that connect to the proxy and receive injected
          credentials.
        </p>
      </div>

      <Suspense>
        <AgentsContent />
      </Suspense>
    </div>
  );
}
