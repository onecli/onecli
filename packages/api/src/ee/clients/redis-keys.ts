export const redisKeys = {
  quotaInjectionCalls: (orgId: string) => {
    const now = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    return `api:quota:injection-calls:${orgId}:${month}`;
  },

  requests: (
    orgId: string,
    workspaceId: string,
    agentId: string,
    date: string,
  ) => `api:requests:${orgId}:${workspaceId}:${agentId}:${date}`,

  injections: (
    orgId: string,
    workspaceId: string,
    agentId: string,
    date: string,
  ) => `api:injections:${orgId}:${workspaceId}:${agentId}:${date}`,

  // Serializes every read-modify-write of the Cognito app client's config
  // (one shared client → one global lock).
  cognitoClientLock: () => "api:lock:cognito-client",

  // Fixed-window rate-limit buckets (ee/middleware/rate-limit.ts). The
  // bucket index is part of the key so windows roll over naturally; the
  // TTL is belt-and-suspenders cleanup.
  throttle: (name: string, id: string, windowSeconds: number) => {
    const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
    return `api:throttle:${name}:${id}:${bucket}`;
  },
};
