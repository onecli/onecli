import { Suspense } from "react";
import type { Metadata } from "next";
import { PoliciesContent } from "./_components/policies-content";

export const metadata: Metadata = {
  title: "Policies",
};

export default function PoliciesPage() {
  return (
    <div className="flex flex-1 flex-col gap-6 p-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Policies</h1>
        <p className="text-muted-foreground text-sm">
          Connect agents to secrets. A policy grants an agent access to a
          specific credential.
        </p>
      </div>

      <Suspense>
        <PoliciesContent />
      </Suspense>
    </div>
  );
}
