import { auth } from "@/lib/auth/nextauth-config";
import { db } from "@onecli/db";
import { generateApiKey } from "@/lib/services/api-key-service";
import { getAuthMode } from "./auth-mode";
import type { AuthUser } from "./types";

const LOCAL_AUTH_ID = "local-admin";
const LOCAL_USER: AuthUser = {
  id: LOCAL_AUTH_ID,
  email: "admin@localhost",
  name: "Admin",
};

let localUserEnsured = false;

const ensureLocalUser = async () => {
  if (localUserEnsured) return;

  const user = await db.user.upsert({
    where: { externalAuthId: LOCAL_AUTH_ID },
    create: {
      externalAuthId: LOCAL_AUTH_ID,
      email: LOCAL_USER.email,
      name: LOCAL_USER.name,
    },
    update: {},
    select: { id: true },
  });

  // Ensure the local user has an Account + AccountMember + ApiKey
  const membership = await db.accountMember.findFirst({
    where: { userId: user.id },
    select: { accountId: true },
  });

  if (!membership) {
    const account = await db.account.create({
      data: {
        name: LOCAL_USER.name,
        createdByUserId: user.id,
        createdByUserEmail: LOCAL_USER.email,
      },
      select: { id: true },
    });

    await db.accountMember.create({
      data: {
        accountId: account.id,
        userId: user.id,
        userEmail: LOCAL_USER.email,
        role: "owner",
      },
    });

    await db.apiKey.create({
      data: {
        key: generateApiKey(),
        userId: user.id,
        userEmail: LOCAL_USER.email,
        accountId: account.id,
      },
    });
  }

  localUserEnsured = true;
};

export const getServerSessionImpl = async (): Promise<AuthUser | null> => {
  if (getAuthMode() === "local") {
    await ensureLocalUser();
    return LOCAL_USER;
  }

  const session = await auth();
  if (!session?.user?.id || !session.user.email) return null;

  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name ?? undefined,
  };
};
