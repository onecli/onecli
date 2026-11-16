import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth/server";
import { getUserDefaultOrgId } from "@/lib/auth/default-org";
import { ProfileBody } from "@/lib/settings-modal/profile-body";
import { redirectToSettingsModal } from "@/lib/settings-modal/redirect-to-modal";

export const metadata: Metadata = {
  title: "Profile",
};

/**
 * Every `/account` address. The account lives in Settings > Profile: with an
 * org, the page forwards there (over the org's landing, in one hop). With
 * none (removed from or suspended in their only org, or signed up through
 * an invitation they never accepted) there is no landing to open the modal
 * over, so the profile renders here as a page, and renaming, the password,
 * SSH keys and deleting the account stay within reach, as they were before
 * the modal. Signed out, it is the sign-in page: the profile's reads need a
 * user, and would otherwise fail the render.
 */
export default async function AccountPage() {
  if (!(await getServerSession())) redirect("/auth/login");
  const orgId = await getUserDefaultOrgId();
  if (orgId) {
    await redirectToSettingsModal({ organizationId: orgId }, "profile");
  }
  return <ProfileBody />;
}
