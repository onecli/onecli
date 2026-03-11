import { auth } from "@/lib/auth/nextauth-config";
import { db } from "@onecli/db";
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
  await db.user.upsert({
    where: { externalAuthId: LOCAL_AUTH_ID },
    create: {
      externalAuthId: LOCAL_AUTH_ID,
      email: LOCAL_USER.email,
      name: LOCAL_USER.name,
    },
    update: {},
  });
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
