import { apiFetch } from "@/lib/api-fetch";

/**
 * A refused API call, carrying the HTTP status alongside the server's message.
 * The status is what lets a caller treat a specific refusal as a state rather
 * than a failure — e.g. the composer renders a 409 (the follow-up cap:
 * "give me a moment to catch up") inline instead of toasting it — without
 * string-matching copy.
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const extractErrorMessage = (body: Record<string, unknown>, status: number) => {
  const err = body.error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err)
    return String((err as { message: unknown }).message);
  return `Request failed: ${status}`;
};

/** Exported for the raw-body callers (`uploadImage`) that can't ride the
 * JSON verbs below — every refusal parse lives here, whatever the verb. */
export const refusal = async (res: Response): Promise<ApiError> => {
  const body = await res.json().catch(() => ({}));
  return new ApiError(extractErrorMessage(body, res.status), res.status);
};

/** Explicit workspace targeting for callers whose URL carries no scope (the
 * org-level Get Started picker, onboarding). The override wins over the
 * path-derived scope (apiFetch spreads options.headers last) and the server
 * re-fences it against the caller's memberships. */
export const workspaceScope = (
  workspaceId?: string,
): RequestInit | undefined =>
  workspaceId ? { headers: { "X-Workspace-Id": workspaceId } } : undefined;

export const apiGet = async <T>(
  path: string,
  init?: RequestInit,
): Promise<T> => {
  const res = await apiFetch(path, init);
  if (!res.ok) throw await refusal(res);
  return res.json();
};

export const apiPost = async <T>(
  path: string,
  body: unknown,
  init?: RequestInit,
): Promise<T> => {
  const res = await apiFetch(path, {
    method: "POST",
    body: JSON.stringify(body),
    ...init,
  });
  if (!res.ok) throw await refusal(res);
  return res.json();
};

export const apiPatch = async <T>(path: string, body: unknown): Promise<T> => {
  const res = await apiFetch(path, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await refusal(res);
  return res.json();
};

export const apiPut = async <T>(path: string, body: unknown): Promise<T> => {
  const res = await apiFetch(path, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await refusal(res);
  return res.json();
};

export const apiDelete = async (
  path: string,
  body?: unknown,
  init?: RequestInit,
): Promise<void> => {
  const res = await apiFetch(path, {
    method: "DELETE",
    // Some deletes carry options (channel detach: `{ deleteRemote }`); a plain
    // delete sends no body at all, exactly as before.
    ...(body !== undefined && { body: JSON.stringify(body) }),
    ...init,
  });
  if (!res.ok) throw await refusal(res);
};
