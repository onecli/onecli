import type { ModalAction } from "./protocol";

/**
 * A modal's control as the agent types it back: `e10 "Dismiss"`, or the
 * label alone where the reply printed no element list. Shared by the
 * reply's header (cli.ts) and the behind-a-modal error (driver.ts), so the
 * two never spell the same control two ways. A file of its own, importing
 * only a type: the command's bundle stays at node's own modules (see
 * reply.ts).
 */
export const describeAction = (action: ModalAction): string =>
  action.ref ? `${action.ref} "${action.label}"` : `"${action.label}"`;
