/**
 * The home-sync byte budget — a LEAF module (no imports) because both
 * transport.ts and memory-file.ts need it and transport imports memory-file's
 * caps; keeping the budget here is what keeps that edge acyclic (a cycle
 * leaves one side's constants undefined at schema-build time, which zod
 * surfaces as an unrelated locale TypeError).
 */

/**
 * One home-sync frame's serialized budget, in UTF-8 BYTES (step 9),
 * measured on the supervisor-side frame with `syncFrameByteLength`. The
 * runner's WS drops >256KB frames whole and silently; 200_000 leaves
 * headroom for the envelope and multi-byte content — a chars budget would
 * let CJK content triple past the cap. Enforced at the SENDER (the control
 * plane's part packer plus a wire refine), the same law as every bound on
 * this wire.
 */
export const MAX_SYNC_PART_BYTES = 200_000;

/**
 * Parts per skills.changed work item — bounds one HTTP work item.
 *
 * Sized against the AUTHORING caps at their worst encoding, not at ASCII.
 * Every cap upstream counts UTF-16 chars while this budget counts UTF-8
 * bytes, so the same permitted content is 1× at ASCII, 3× in CJK, and up to
 * 6× when JSON escapes control characters. A fully-maxed agent packs to ~24
 * parts in ASCII and ~84 in CJK; 64 would have silently truncated every
 * non-Latin agent that filled its caps. 256 covers the 6× ceiling.
 */
export const MAX_SYNC_PARTS = 256;

/** The byte measure the packer and the wire refines share. */
export const syncFrameByteLength = (frame: unknown): number =>
  new TextEncoder().encode(JSON.stringify(frame)).length;
