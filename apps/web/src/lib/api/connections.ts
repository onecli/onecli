import { apiGet, apiPatch, apiDelete } from "./client";
import type { Connection } from "./types";

export type ConnectionScope = "project" | "organization";

const connectionsPath = (scope: ConnectionScope) =>
  scope === "organization"
    ? "/v1/org/apps/connections"
    : "/v1/apps/connections";

export const list = () =>
  apiGet<{ connections: Connection[] }>("/v1/apps/connections").then(
    (r) => r.connections,
  );

export const rename = (id: string, label: string) =>
  apiPatch<{ id: string; label: string }>(`/v1/apps/connections/${id}`, {
    label,
  });

export const disconnect = (id: string, scope: ConnectionScope = "project") =>
  apiDelete(`${connectionsPath(scope)}/${id}`);
