import { z } from "zod";

/**
 * Attachment upload/bind validation. The byte caps themselves live in
 * `@onecli/agent-protocol` (one definition for control plane, runner and
 * supervisor); these are the request-shape gates around them. The caps are
 * re-exported here for the WEB composer, which imports validations (client-
 * safe constants) rather than growing its own agent-protocol edge.
 */
export {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  isPreviewableImageType,
} from "@onecli/agent-protocol";

/** The raw client-supplied file name — sanitized (sanitizeAttachmentName)
 * before it is stored or ever becomes a path segment; this only bounds the
 * input. */
export const attachmentNameSchema = z.string().min(1).max(255);

/**
 * A media type as the upload door accepts it: the bare `type/subtype` token,
 * no parameters (the route strips `; charset=…` before parsing). Bounded and
 * shape-checked because it is echoed into download responses and the
 * sandbox manifest.
 */
export const attachmentMimeSchema = z
  .string()
  .min(3)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i);
