import type { Metadata } from "next";
import { PageHeader } from "@dashboard/page-header";
import { ProfileForm } from "./_components/profile-form";
import { KeyManagementCard } from "./_components/key-management-card";

export const metadata: Metadata = {
  title: "Profile",
};

export default function ProfilePage() {
  return (
    <div className="flex flex-1 flex-col gap-6 max-w-5xl">
      <div className="flex flex-col gap-4">
        <PageHeader title="Profile" />
        <ProfileForm />
      </div>
      <div className="flex flex-col gap-4">
        <PageHeader title="Encryption" />
        <KeyManagementCard />
      </div>
    </div>
  );
}
