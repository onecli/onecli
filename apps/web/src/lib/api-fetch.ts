import { IS_CLOUD } from "@/lib/env";
import { apiOrigin } from "@onecli/api/lib/public-origins";
import { WORKSPACE_PATH_RE, ORG_PATH_RE } from "@/lib/navigation";

/**
 * Every edition serves /v1 from the dedicated api-server origin. Cloud
 * authenticates with a Cognito bearer token against the baked origin;
 * self-host rides the session cookie cross-port (cookies are per-host, not
 * per-port — the same proven posture as the dashboard→gateway calls) against
 * the runtime origin injected by the root layout, since prebuilt images
 * cannot bake a deployment's URL.
 */
export const API_ORIGIN = IS_CLOUD
  ? apiOrigin()
  : (typeof window !== "undefined" &&
      ((window as unknown as Record<string, unknown>).__API_URL__ as string)) ||
    apiOrigin();

export const getAuthToken = async (): Promise<string | undefined> => {
  // Cookie auth outside cloud — no bearer token. The dynamic import keeps the
  // amplify client chunk out of non-cloud bundles.
  if (!IS_CLOUD) return undefined;
  try {
    const { fetchAuthSession } = await import("aws-amplify/auth");
    const session = await fetchAuthSession();
    return session.tokens?.idToken?.toString();
  } catch {
    return undefined;
  }
};

export const getWorkspaceId = (): string | undefined => {
  if (typeof window === "undefined") return undefined;
  return window.location.pathname.match(WORKSPACE_PATH_RE)?.[1];
};

export const getOrganizationId = (): string | undefined => {
  if (typeof window === "undefined") return undefined;
  return window.location.pathname.match(ORG_PATH_RE)?.[1];
};

export const apiFetch = async (
  path: string,
  options?: RequestInit,
): Promise<Response> => {
  const token = await getAuthToken();
  const workspaceId = getWorkspaceId();
  const organizationId = getOrganizationId();

  return fetch(`${API_ORIGIN}${path}`, {
    ...options,
    // Self-host: the API lives on another port of the same host, so the
    // session cookie must be sent explicitly (the api-server allows this
    // origin — it is one of the deployment's own). Cloud uses the bearer
    // token instead.
    ...(IS_CLOUD ? null : { credentials: "include" as const }),
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(workspaceId ? { "X-Workspace-Id": workspaceId } : {}),
      ...(organizationId ? { "X-Organization-Id": organizationId } : {}),
      ...(options?.headers as Record<string, string> | undefined),
    },
  });
};

/**
 * The binary sibling of `apiFetch` — same origin, auth, tenancy headers and
 * cookie/bearer split, WITHOUT the forced JSON Content-Type: `apiFetch`
 * spreads caller headers over its own, so a caller can only override (never
 * delete) `Content-Type`, and a raw upload's type must be the file's own.
 */
export const apiUpload = async (
  path: string,
  body: Blob,
  options?: {
    contentType?: string;
    signal?: AbortSignal;
    /** POST creates under a collection (attachments); PUT replaces THE
     * resource at the path (an agent's one avatar). */
    method?: "POST" | "PUT";
  },
): Promise<Response> => {
  const token = await getAuthToken();
  const workspaceId = getWorkspaceId();
  const organizationId = getOrganizationId();

  return fetch(`${API_ORIGIN}${path}`, {
    method: options?.method ?? "POST",
    body,
    ...(IS_CLOUD ? null : { credentials: "include" as const }),
    ...(options?.signal ? { signal: options.signal } : {}),
    headers: {
      "Content-Type": options?.contentType || "application/octet-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(workspaceId ? { "X-Workspace-Id": workspaceId } : {}),
      ...(organizationId ? { "X-Organization-Id": organizationId } : {}),
    },
  });
};
