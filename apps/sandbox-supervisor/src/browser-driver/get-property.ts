/**
 * What `get` reads off an element: its visible text, a field's value, a
 * link's href. Dependency-free like target.ts: the command's bundle imports
 * it for the grammar (bundle.test.ts keeps that bundle at node's own
 * modules), the protocol for the schema.
 */
export const GET_PROPERTIES = ["text", "value", "href"] as const;
export type GetProperty = (typeof GET_PROPERTIES)[number];

export const isGetProperty = (
  value: string | undefined,
): value is GetProperty =>
  value !== undefined && (GET_PROPERTIES as readonly string[]).includes(value);
