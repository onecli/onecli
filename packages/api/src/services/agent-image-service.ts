import { randomBytes } from "node:crypto";
import { db } from "@onecli/db";
import { getSelfUrl } from "../providers/self-url";
import { ServiceError } from "./errors";

/**
 * The agent's avatar image. Bytes live inline on the agent row (the
 * attachments precedent — self-host's api container has no writable disk
 * besides Postgres, and one capped image per agent is tiny; an external
 * store can later take over behind the same service without a migration).
 *
 * Serving is PUBLIC by design: Slack fetches `icon_url` unauthenticated, so
 * the GET is fenced by `imageKey` — 128 bits of randomness in the path,
 * rotated on every upload, the presigned-URL/`url_private` model. The image
 * is an avatar the whole Slack workspace sees anyway; the key stops
 * enumeration, not disclosure to intended viewers.
 *
 * Accepted risk, unlike a true presigned URL: the key rides the URL path, so
 * it lands in request logs and never expires on its own (only the next
 * upload rotates it). What it protects is a public avatar — a log reader
 * gains a picture the Slack workspace already sees, nothing more.
 */

export const MAX_AGENT_IMAGE_BYTES = 1024 * 1024; // 1MB

/**
 * Raster-only, verified by MAGIC BYTES — never the client's Content-Type.
 * SVG is deliberately refused: a stored SVG is a script container, and even
 * with nosniff the risk buys nothing an avatar needs.
 */
const sniffImageMime = (bytes: Buffer): string | null => {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (
    bytes.length >= 6 &&
    ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))
  ) {
    return "image/gif";
  }
  return null;
};

const requireAgent = async (workspaceId: string, agentId: string) => {
  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId },
    select: { id: true },
  });
  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");
  return agent;
};

/** Store (or replace) the avatar. The key rotates on every write, so an old
 * URL cached anywhere stops serving the moment a new image lands. */
export const setAgentImage = async (
  workspaceId: string,
  agentId: string,
  bytes: Buffer,
): Promise<{ imageUrl: string }> => {
  await requireAgent(workspaceId, agentId);
  if (bytes.byteLength > MAX_AGENT_IMAGE_BYTES) {
    throw new ServiceError(
      "UNPROCESSABLE",
      `Images are capped at ${Math.floor(MAX_AGENT_IMAGE_BYTES / (1024 * 1024))}MB.`,
    );
  }
  const mime = sniffImageMime(bytes);
  if (!mime) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "The image must be a PNG, JPEG, WebP, or GIF.",
    );
  }
  const imageKey = randomBytes(16).toString("hex");
  await db.agent.update({
    where: { id: agentId },
    data: {
      imageData: new Uint8Array(bytes),
      imageMime: mime,
      imageKey,
    },
    // Without a select the update reads the just-written 1MB blob back.
    select: { id: true },
  });
  return { imageUrl: agentImageUrl(agentId, imageKey) };
};

export const clearAgentImage = async (
  workspaceId: string,
  agentId: string,
): Promise<void> => {
  await requireAgent(workspaceId, agentId);
  await db.agent.update({
    where: { id: agentId },
    data: { imageData: null, imageMime: null, imageKey: null },
    select: { id: true },
  });
};

/** The public serving read — fenced by the key alone (no session: Slack's
 * fetch carries none). Both id AND key must match; a wrong key is a 404,
 * hint-free. */
export const getAgentImageByKey = async (
  agentId: string,
  imageKey: string,
): Promise<{ bytes: Buffer; mime: string }> => {
  // Key format gate before the query — an empty/oversized key never reaches
  // the index.
  if (!/^[a-f0-9]{32}$/.test(imageKey)) {
    throw new ServiceError("NOT_FOUND", "Not found");
  }
  const agent = await db.agent.findFirst({
    where: { id: agentId, imageKey },
    select: { imageData: true, imageMime: true },
  });
  if (!agent?.imageData || !agent.imageMime) {
    throw new ServiceError("NOT_FOUND", "Not found");
  }
  return { bytes: Buffer.from(agent.imageData), mime: agent.imageMime };
};

/** The public URL for a stored image, on the API's own configured origin —
 * the same origin Slack is given for callbacks, so the two can never
 * disagree. */
export const agentImageUrl = (agentId: string, imageKey: string): string =>
  `${getSelfUrl().replace(/\/$/, "")}/v1/agent-images/${agentId}/${imageKey}`;

/** Map helper for list/detail projections: the URL when an image exists,
 * null otherwise. */
export const agentImageUrlOrNull = (
  agentId: string,
  imageKey: string | null,
): string | null => (imageKey ? agentImageUrl(agentId, imageKey) : null);
