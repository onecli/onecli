import type { Metadata } from "next";
import { PageHeader } from "@dashboard/page-header";
import { ProfileForm } from "./_components/profile-form";

export const metadata: Metadata = {
  title: "Profile",
};

export default function ProfilePage() {
  return (
    <div className="flex flex-1 flex-col gap-4">
      <PageHeader
        title="Profile"
        description="Manage your personal information."
      />
      <ProfileForm />
    </div>
  );
}
