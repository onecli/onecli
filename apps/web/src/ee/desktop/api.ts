import { apiDelete, apiGet, apiPost } from "@/lib/api/client";

/**
 * The agent's desktop: what the Computer section reads, as the server composed it for THIS viewer. `controlHost` is set
 * only while the viewer holds the control lease (the input stream's host);
 * everyone else sees `controller` and watches on `viewHost`.
 */
export interface DesktopState {
  available: boolean;
  /** `unviewable`: running, but the image has a desktop nobody can watch
   * (no VNC server); the section says so instead of waiting. */
  sandboxState: "asleep" | "waking" | "awake" | "unviewable";
  viewHost: string | null;
  controlHost: string | null;
  controller: { userId: string; name: string; since: string } | null;
  /** The agent's open ask, if any: it wants a person to take over. */
  request: { id: string; reason: string; at: string } | null;
  you: { controlling: boolean };
}

const base = (agentId: string) =>
  `/v1/agents/${encodeURIComponent(agentId)}/desktop`;

export const get = (agentId: string) => apiGet<DesktopState>(base(agentId));

/** Start the sandbox so there is a screen to look at. 202 with the state
 * as it now stands (`waking`); the boot itself is asynchronous. */
export const wake = (agentId: string) =>
  apiPost<DesktopState>(`${base(agentId)}/wake`, {});

/** Take the control lease. 409 when someone else holds it. */
export const takeControl = (agentId: string) =>
  apiPost<DesktopState>(`${base(agentId)}/control`, {});

/** Hand the desktop back (Stop). A pending ask is settled and the agent
 * resumes. */
export const releaseControl = (agentId: string) =>
  apiDelete(`${base(agentId)}/control`);

/** The desktop stream's credential: a one-minute, host-bound ticket the
 * page offers in the WebSocket subprotocol. Minted per connection. */
export const ticket = (host: string) =>
  apiPost<{ ticket: string }>("/v1/preview-auth/desktop-ticket", { host });
