import { Suspense } from "react";
import type { Metadata } from "next";
import { PageHeader } from "@dashboard/page-header";
import { SecretsContent } from "./_components/secrets-content";

export const metadata: Metadata = {
  title: "Secrets",
};

export default function SecretsPage() {
  return (
    <div className="flex flex-1 flex-col gap-6 max-w-5xl">
      <PageHeader
        title="Secrets"
        description="Manage encrypted credentials that the gateway injects into requests."
      />
      <Suspense>
        <SecretsContent />
      </Suspense>
    </div>
  );
}
