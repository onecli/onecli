/**
 * Policy runtime edition helpers. Pure and dependency-free (reads only
 * `process.env` plus the pure edition parser), so it is safe to import from
 * routes, middleware, or a standalone startup entry.
 */
import { parseEdition } from "./edition";

const runtimeEdition = () =>
  parseEdition(process.env.EDITION ?? process.env.NEXT_PUBLIC_EDITION).edition;

/** Whether this runtime is the onprem edition — used by the shared policy
 * service to phrase capability rejections as OneCLI Cloud pointers there
 * (byte-identical messages everywhere else). */
export const isOnpremEdition = (): boolean => runtimeEdition() === "onprem";
