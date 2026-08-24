import { apiGet, apiPatch, apiPost, apiDelete, refusal } from "./client";
import { apiUpload } from "@/lib/api-fetch";
import type {
  Agent,
  AgentDetail,
  AgentEffort,
  AgentModels,
  CreatedAgent,
  CreateAgentInput,
  MintedSshCertificate,
  MintSshCertificateSource,
} from "./types";

// Explicit workspace targeting exists for the org-level Get Started picker,
// which reads agents of a workspace the URL doesn't carry. The override wins
// over the path-derived scope (apiFetch spreads options.headers last) and the
// server re-fences it against the caller's memberships.
const workspaceScope = (workspaceId?: string): RequestInit | undefined =>
  workspaceId ? { headers: { "X-Workspace-Id": workspaceId } } : undefined;

export const list = (options: { workspaceId?: string } = {}) =>
  apiGet<Agent[]>("/v1/agents", workspaceScope(options.workspaceId));

// Encoded like `conversationPath`: the id can arrive DECODED from the URL
// (`useParams`), and an unencoded crafted segment would URL-normalize the
// request onto a different /v1 path under the caller's credentials.
export const get = (agentId: string) =>
  apiGet<AgentDetail>(`/v1/agents/${encodeURIComponent(agentId)}`);

export const create = (input: CreateAgentInput) =>
  apiPost<CreatedAgent>("/v1/agents", input);

/**
 * What this agent can run, and what it runs now (§3.10). Always 200 for an
 * agent that exists — "no key granted yet" comes back as `provider: null`.
 */
export const models = (agentId: string) =>
  apiGet<AgentModels>(`/v1/agents/${encodeURIComponent(agentId)}/models`);

/**
 * PATCH — name, the instructions brief, and the model/effort override
 * (hosted only). Null clears any of them; for model/effort that means
 * "go back to the provider's default", which is the normal state.
 */
export const update = (
  agentId: string,
  input: {
    name?: string;
    instructions?: string | null;
    model?: string | null;
    effort?: AgentEffort | null;
  },
) =>
  apiPatch<{ success: boolean }>(
    `/v1/agents/${encodeURIComponent(agentId)}`,
    input,
  );

/**
 * PUT the avatar as a raw binary body (the attachments-door pattern — the
 * repo has no multipart anywhere). The server verifies the format by magic
 * bytes; the Content-Type here is advisory only.
 */
export const uploadImage = async (
  agentId: string,
  file: Blob,
): Promise<{ imageUrl: string }> => {
  const res = await apiUpload(
    `/v1/agents/${encodeURIComponent(agentId)}/image`,
    file,
    { method: "PUT", contentType: file.type },
  );
  if (!res.ok) throw await refusal(res);
  return res.json();
};

export const deleteImage = (agentId: string) =>
  apiDelete(`/v1/agents/${encodeURIComponent(agentId)}/image`);

/**
 * Mint a short-lived OpenSSH user certificate for this hosted agent
 * (sandbox-platform step 5). The source is a registered key's id (the
 * one-click path) or a pasted public key line. Refusals are STATES the SSH
 * section renders inline off `ApiError.status`: 404 = no SSH front door on
 * this deployment or the registered key is gone, 422 = not an ed25519 key,
 * 429 = mint rate limit.
 */
export const mintSshCertificate = (
  agentId: string,
  input: MintSshCertificateSource,
) =>
  apiPost<MintedSshCertificate>(
    `/v1/agents/${encodeURIComponent(agentId)}/ssh-certificate`,
    input,
  );
