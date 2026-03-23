import type { Metadata } from "next";
import { PageHeader } from "@dashboard/page-header";
import { KeyManagementCard } from "@/app/(dashboard)/settings/profile/_components/key-management-card";

export const metadata: Metadata = {
  title: "Encryption",
};

export default function EncryptionPage() {
  return (
    <div className="flex flex-1 flex-col gap-4 max-w-5xl">
      <PageHeader
        title="Encryption"
        description="Configure how your secrets are encrypted."
      />
      <KeyManagementCard />
    </div>
  );
}
