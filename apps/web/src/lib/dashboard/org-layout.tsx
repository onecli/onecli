import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth/server";
import { db } from "@onecli/db";
import { OverQuotaBanner } from "@/ee/billing/_components/over-quota-banner";
import { SetDefaultOrgCookie } from "@/lib/dashboard/set-default-org-cookie";

interface Props {
  children: React.ReactNode;
  params: Promise<{ orgId: string }>;
}

export default async function OrgLayout({ children, params }: Props) {
  const { orgId } = await params;
  const session = await getServerSession();
  if (!session) redirect("/auth/login");

  const user = await db.user.findUnique({
    where: { externalAuthId: session.id },
    select: { id: true },
  });
  if (!user) redirect("/auth/login");

  const membership = await db.organizationMember.findUnique({
    where: {
      organizationId_userId: {
        organizationId: orgId,
        userId: user.id,
      },
    },
    select: { organizationId: true, status: true },
  });

  if (!membership || membership.status === "suspended") {
    redirect("/org");
  }

  return (
    <>
      <SetDefaultOrgCookie orgId={orgId} />
      <OverQuotaBanner />
      {children}
    </>
  );
}
