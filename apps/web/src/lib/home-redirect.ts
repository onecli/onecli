import { apiFetch } from "@/lib/api-fetch";

export const resolveHomeRedirect = async (): Promise<string> => {
  await apiFetch("/v1/auth/session");
  return "/overview";
};
