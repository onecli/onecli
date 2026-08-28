import { apiGet } from "@/lib/api/client";
import { apiFetch } from "@/lib/api-fetch";

export interface CliConnectWorkspace {
  id: string;
  name: string | null;
}

export interface CliConnectOrg {
  id: string;
  name: string;
  workspaces: CliConnectWorkspace[];
}

export interface CliConnectOptions {
  organizations: CliConnectOrg[];
}

/** Lists the user's orgs + workspaces for the CLI connect screen. */
export const getCliConnectOptions = () =>
  apiGet<CliConnectOptions>("/v1/auth/cli/options");

/**
 * Confirms a CLI device-auth session for the chosen workspace. Sends the workspace
 * via `X-Workspace-Id` (the page itself has no workspace in its URL). Uses raw
 * `apiFetch` rather than the typed `apiPost` because we need a custom header;
 * the error parse mirrors the typed client so auth errors (the nested
 * `{ error: { message } }` shape) render their real message, not "[object Object]".
 */
export const confirmCliSession = async (
  code: string,
  workspaceId: string,
): Promise<void> => {
  const res = await apiFetch("/v1/auth/cli/confirm", {
    method: "POST",
    body: JSON.stringify({ code }),
    headers: { "X-Workspace-Id": workspaceId },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    const err = body.error;
    throw new Error(
      typeof err === "string"
        ? err
        : ((err as { message?: string } | undefined)?.message ??
            "Failed to confirm"),
    );
  }
};
