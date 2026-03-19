import { Suspense } from "react";
import type { Metadata } from "next";
import { PageHeader } from "@dashboard/page-header";
import { RulesContent } from "./_components/rules-content";

export const metadata: Metadata = {
  title: "Rules",
};

export default function RulesPage() {
  return (
    <div className="flex flex-1 flex-col gap-6 max-w-5xl">
      <PageHeader
        title="Rules"
        description="Control what your agents can and cannot access."
      />
      <Suspense>
        <RulesContent />
      </Suspense>
    </div>
  );
}
