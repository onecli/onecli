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

/**
 * The server's own words in a refusal body, or `null` when it has none.
 *
 * The API answers in two envelopes: `{ error: { message, type } }` from the
 * global error handler (every ServiceError-mapped refusal) and a bare
 * `{ error: "…" }` from the routes that answer directly (the upload's 413,
 * billing's plan checks, the invitation accept). Read BOTH.
 *
 * `body` is whatever `res.json()` parsed — `null`, an array, a number, or an
 * envelope whose `message` is not a string are all possible when something
 * between the browser and the API (a proxy, an edge) answers instead. Only a
 * STRING is ever returned: coercing another shape either throws (a `toString`
 * that isn't callable) or renders "[object Object]" to a person. Every caller
 * keeps its own fallback sentence for the `null` case.
 */
export const refusalMessage = (body: unknown): string | null => {
  if (typeof body !== "object" || body === null || !("error" in body)) {
    return null;
  }
  const error = body.error;
  if (typeof error === "string") return error;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return null;
};

/** Exported for the raw-body callers (`uploadImage`, the attachments door)
 * that can't ride the JSON verbs below — every refusal parse lives here,
 * whatever the verb. */
export const refusal = async (res: Response): Promise<ApiError> => {
  const body: unknown = await res.json().catch(() => null);
  return new ApiError(
    refusalMessage(body) ?? `Request failed: ${res.status}`,
    res.status,
  );
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
