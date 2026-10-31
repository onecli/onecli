import { z } from "zod";
import type {
  ConnectRequestBody,
  ConnectResponse,
} from "@onecli/api/apps/connect-credentials";
import { apiFetch } from "@/lib/api-fetch";
import { refusal } from "./client";
import type { ConnectionTestScope } from "./connection-test";

export interface SaveCredentialsRequest {
  appId: string;
  scope: ConnectionTestScope;
  body: ConnectRequestBody;
}
const responseSchema = z.object({
  success: z.literal(true),
  connectionId: z.string().trim().min(1),
  connection: z
    .object({ id: z.string().trim().min(1), label: z.string().nullable() })
    .optional(),
});

/** Bounds auth, saving and reading the response, not just the fetch itself. */
export const saveCredentials = async ({
  appId,
  scope,
  body,
}: SaveCredentialsRequest): Promise<ConnectResponse> => {
  const scopeId =
    scope.kind === "organization" ? scope.organizationId : scope.workspaceId;
  if (
    (scope.kind === "organization" || scopeId !== undefined) &&
    !scopeId?.trim()
  )
    throw new Error("An explicit connection scope is required.");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Saving the connection timed out. Try again.");
      reject(error);
      controller.abort(error);
    }, 25_000);
  });
  const request = async (): Promise<ConnectResponse> => {
    const response = await apiFetch(
      `/v1/${scope.kind === "organization" ? "org/" : ""}apps/${encodeURIComponent(appId)}/connect`,
      {
        method: "POST",
        body: JSON.stringify(body),
        signal: controller.signal,
        // Ordinary workspace connects may rely on apiFetch's ambient/default
        // scope. Explicit scopes instead clear the opposite ambient header.
        ...(scopeId?.trim()
          ? {
              headers: {
                "X-Workspace-Id": scope.kind === "workspace" ? scopeId : "",
                "X-Organization-Id":
                  scope.kind === "organization" ? scopeId : "",
              },
            }
          : {}),
      },
    );
    if (!response.ok) throw await refusal(response);
    const parsed = responseSchema.safeParse(
      await response.json().catch(() => null),
    );
    if (
      !parsed.success ||
      (parsed.data.connection &&
        parsed.data.connection.id !== parsed.data.connectionId)
    ) {
      throw new Error(
        "The server returned an invalid saved connection. Try again.",
      );
    }
    return parsed.data;
  };
  try {
    return await Promise.race([request(), deadline]);
  } finally {
    clearTimeout(timer);
  }
};
