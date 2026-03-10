import { Suspense } from "react";
import type { Metadata } from "next";
import { SecretsContent } from "./_components/secrets-content";

export const metadata: Metadata = {
  title: "Secrets",
};

export default function SecretsPage() {
  return (
    <div className="flex flex-1 flex-col gap-6 p-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Secrets</h1>
        <p className="text-muted-foreground text-sm">
          Manage encrypted credentials that the proxy injects into requests.
        </p>
      </div>

      <Suspense>
        <SecretsContent />
      </Suspense>
    </div>
  );
}
