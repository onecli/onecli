export const resolveHomeRedirect = async (): Promise<string> => {
  await fetch("/api/auth/session");
  return "/overview";
};
