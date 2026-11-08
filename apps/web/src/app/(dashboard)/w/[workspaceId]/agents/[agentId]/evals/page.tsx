import type { Metadata } from "next";
import { Suspense } from "react";
import { EvalsSection } from "./_components/evals-section";

export const metadata: Metadata = {
  title: "Evals",
};

export default function AgentEvalsPage() {
  return (
    // Suspense: the section reads `?run=` (useSearchParams), the link a
    // scheduled run's report opens.
    <Suspense>
      <EvalsSection />
    </Suspense>
  );
}
