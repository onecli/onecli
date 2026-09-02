import { redirect } from "next/navigation";

export default async function SecretsRedirectPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId?: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { workspaceId } = await params;
  const sp = await searchParams;

  const prefix = workspaceId ? `/w/${workspaceId}` : "";
  const base = `${prefix}/connections`;

  if (sp.create === "anthropic" || sp.create === "openai") {
    redirect(`${base}/llms?create=${sp.create}`);
  }

  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (value) qs.set(key, value);
  }
  const query = qs.toString();
  redirect(`${base}/custom${query ? `?${query}` : ""}`);
}
