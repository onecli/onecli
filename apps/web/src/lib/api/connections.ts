import { apiGet, apiPatch, apiDelete } from "./client";
import type { PageScope } from "./scope";
import type { Connection } from "./types";

const connectionsPath = (scope: PageScope) =>
  scope === "organization" ? "/v1/org/connections" : "/v1/connections";

export const list = (scope: PageScope = "project") =>
  apiGet<Connection[]>(connectionsPath(scope));

export const rename = (
  id: string,
  label: string,
  scope: PageScope = "project",
) =>
  apiPatch<{ id: string; label: string }>(`${connectionsPath(scope)}/${id}`, {
    label,
  });

export const disconnect = (id: string, scope: PageScope = "project") =>
  apiDelete(`${connectionsPath(scope)}/${id}`);
