import { apiGet, apiDelete } from "./client";
import type { Connection } from "./types";

export const list = () =>
  apiGet<{ connections: Connection[] }>("/v1/apps/connections").then(
    (r) => r.connections,
  );

export const disconnect = (id: string) =>
  apiDelete(`/v1/apps/connections/${id}`);
