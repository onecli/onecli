import { z } from "zod";
import { getGatewayFetchOptions } from "@/lib/gateway-auth";
import { getGatewayApiUrl } from "@/lib/gateway-url";
import { ConnectionTestError } from "./connection-test-error";

export type ConnectionTestScope =
  | { kind: "workspace"; workspaceId: string | undefined }
  | { kind: "organization"; organizationId: string | undefined };

const responseSchema = z.object({
  ok: z.literal(true),
  superuser: z.boolean(),
});
const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.array(z.unknown()),
  }),
});
export type ConnectionTestResponse = z.infer<typeof responseSchema>;

export interface ConnectionTestRequest {
  connectionId: string;
  scope: ConnectionTestScope;
}

const requestConnectionTest = async (
  { connectionId, scope }: ConnectionTestRequest,
  signal: AbortSignal,
): Promise<ConnectionTestResponse> => {
  const scopeId =
    scope.kind === "workspace" ? scope.workspaceId : scope.organizationId;
  if (!scopeId?.trim())
    throw new Error("An explicit connection scope is required.");
  if (!connectionId.trim()) throw new Error("A saved connection is required.");
  const { headers, credentials } = await getGatewayFetchOptions();
  signal.throwIfAborted();
  // The popup has no /w or /org URL. Its explicit scope must override the
  // ambient auth helper, and an org check must never inherit a workspace.
  const scopedHeaders = new Headers(headers);
  scopedHeaders.delete("X-Workspace-Id");
  scopedHeaders.delete("X-Organization-Id");
  scopedHeaders.set(
    scope.kind === "workspace" ? "X-Workspace-Id" : "X-Organization-Id",
    scopeId,
  );
  const response = await fetch(
    `${getGatewayApiUrl()}/v1/connections/${encodeURIComponent(connectionId)}/test`,
    {
      method: "POST",
      headers: scopedHeaders,
      credentials,
      signal,
    },
  );
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = errorSchema.safeParse(body);
    throw new ConnectionTestError(
      parsed.success
        ? parsed.data.error.message
        : `Connection test failed (${response.status}).`,
      parsed.success ? parsed.data.error.code : null,
    );
  }
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success)
    throw new Error("The gateway returned an invalid connection test result.");
  return parsed.data;
};

/** Checks stored credentials only. Bound auth, fetch and response-body reads. */
export const testConnection = async (
  input: ConnectionTestRequest,
): Promise<ConnectionTestResponse> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("The connection check timed out. Try again.");
      reject(error);
      controller.abort(error);
    }, 25_000);
  });
  try {
    return await Promise.race([
      requestConnectionTest(input, controller.signal),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
};
