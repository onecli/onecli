import { redirect } from "next/navigation";
import { getUserDefaultOrgId } from "@/lib/auth/default-org";

export default async function OrgIndexPage() {
  const orgId = await getUserDefaultOrgId();
  redirect(orgId ? `/org/${orgId}/workspaces` : "/create-org");
}
