import type { Connection } from "@/lib/api";

/** A connection as the account cards render it: the API row with its JSON
 * metadata narrowed to an object (or null), the shape `AppDetail` passes. */
export type AccountCardConnection = Omit<Connection, "metadata"> & {
  metadata: Record<string, unknown> | null;
};
