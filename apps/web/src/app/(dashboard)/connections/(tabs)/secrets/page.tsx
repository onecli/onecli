import { redirect } from "next/navigation";

export default async function SecretsRedirectPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId?: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { projectId } = await params;
  const sp = await searchParams;

  const prefix = projectId ? `/p/${projectId}` : "";
  const base = `${prefix}/connections`;

  if (sp.create === "anthropic") {
    redirect(`${base}/llms?create=anthropic`);
  }

  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (value) qs.set(key, value);
  }
  const query = qs.toString();
  redirect(`${base}/custom${query ? `?${query}` : ""}`);
}
