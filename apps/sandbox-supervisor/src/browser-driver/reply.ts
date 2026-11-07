import type { Reply } from "./protocol";

/**
 * Whether a parsed line is a reply this build's command can print. The
 * daemon is the same build, so this guards the shape, not the fields. In
 * its own file, importing only a type: the command is the per-call cost,
 * and a value import from protocol.ts would pull zod in (~17 ms a verb,
 * measured). esbuild drops type-only imports, so this keeps the command
 * at Node's own modules.
 */
export const isReply = (value: unknown): value is Reply => {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  if (r.ok === false) return typeof r.error === "string";
  return (
    r.ok === true && typeof r.url === "string" && typeof r.title === "string"
  );
};
