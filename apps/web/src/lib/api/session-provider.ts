import { getServerSession } from "@/lib/auth/server";
import type { SessionProvider } from "@onecli/api";

export const nextSessionProvider: SessionProvider = {
  getSession: async () => {
    const session = await getServerSession();
    if (!session) return null;
    return {
      id: session.id,
      email: session.email,
      name: session.name,
      emailVerified: session.emailVerified,
      federatedProvider: session.federatedProvider,
    };
  },
};
