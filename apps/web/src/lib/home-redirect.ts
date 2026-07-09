import { apiFetch } from "@/lib/api-fetch";
import { CAPS } from "@/lib/env";

export const resolveHomeRedirect = async (): Promise<string> => {
  await apiFetch("/v1/auth/session");
  if (CAPS.webSurface === "connect-only") return "/app-connect";
  return "/overview";
};
