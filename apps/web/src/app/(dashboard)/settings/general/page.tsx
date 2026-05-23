import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PageHeader } from "@dashboard/page-header";
import { IS_CLOUD } from "@/lib/env";
import { PublicUrlForm } from "./_components/public-url-form";

export const metadata: Metadata = {
  title: "General",
};

export default function GeneralSettingsPage() {
  if (IS_CLOUD) redirect("/settings/profile");

  return (
    <div className="flex flex-1 flex-col gap-4">
      <PageHeader
        title="General"
        description="Configure how your instance is accessed."
      />
      <PublicUrlForm />
    </div>
  );
}
