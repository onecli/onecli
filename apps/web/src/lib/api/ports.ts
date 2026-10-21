import { apiDelete, apiGet, apiPost, apiPut } from "./client";

/** Sandbox ports (plans/sandbox-ports.md): one shared port of an agent. */
export interface SandboxPortShare {
  id: string;
  port: number;
  hostname: string;
  url: string;
  visibility: "private" | "link" | "public";
  expiresAt: string | null;
  active: boolean;
  createdAt: string;
}

export interface SandboxPortsResponse {
  shares: SandboxPortShare[];
  /** TCP ports listening inside the agent's computer right now (empty while
   * it is asleep). */
  listening: number[];
}

const base = (agentId: string) =>
  `/v1/agents/${encodeURIComponent(agentId)}/ports`;

export const list = (agentId: string) =>
  apiGet<SandboxPortsResponse>(base(agentId));

export const share = (agentId: string, port: number) =>
  apiPut<SandboxPortShare>(`${base(agentId)}/${port}`, {});

export const unshare = (agentId: string, port: number) =>
  apiDelete(`${base(agentId)}/${port}`);

/** The login handoff: a signed-in viewer trades the preview host for a
 * short-lived, host-bound ticket URL on the preview itself. */
export const previewTicket = (host: string, path: string) =>
  apiPost<{ url: string }>("/v1/preview-auth", { host, path });
