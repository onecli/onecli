import { redirectToSettingsModal } from "@/lib/settings-modal/redirect-to-modal";

interface Props {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** An old URL from before secrets split into tabs: Settings > Apps, on the
 *  LLMs tab for an LLM key's create door (`?create=anthropic|openai`), the
 *  Custom tab otherwise. Straight there, not through the tab's own old URL
 *  (a second redirect). */
export default async function SecretsRedirectPage({
  params,
  searchParams,
}: Props) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const llm = query.create === "anthropic" || query.create === "openai";
  await redirectToSettingsModal({ workspaceId }, "apps", {
    ...query,
    tab: llm ? "llms" : "custom",
  });
}
