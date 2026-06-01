import type { Metadata } from "next";
import { PageHeader } from "@dashboard/page-header";
import { APP_URL } from "@/lib/env";
import { PublicUrlCard } from "./_components/public-url-card";

export const metadata: Metadata = {
  title: "Instance",
};

export default function InstancePage() {
  return (
    <div className="flex flex-1 flex-col gap-4">
      <PageHeader
        title="Instance"
        description="Instance configuration for your self-hosted deployment."
      />
      <PublicUrlCard appUrl={APP_URL} />
    </div>
  );
}
