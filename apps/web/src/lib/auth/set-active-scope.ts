"use server";

import { cookies } from "next/headers";
import { DEFAULT_ORG_COOKIE, COOKIE_MAX_AGE } from "./constants";

const COOKIE_OPTS = {
  path: "/",
  maxAge: COOKIE_MAX_AGE,
  sameSite: "lax" as const,
};

export const setDefaultOrgCookie = async (orgId: string) => {
  const cookieStore = await cookies();
  cookieStore.set(DEFAULT_ORG_COOKIE, orgId, COOKIE_OPTS);
};

export const clearDefaultOrgCookie = async () => {
  const cookieStore = await cookies();
  cookieStore.delete(DEFAULT_ORG_COOKIE);
};
