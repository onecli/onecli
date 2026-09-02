import { db } from "@onecli/db";
import { MAX_TURN_CONTEXT_CHARS } from "@onecli/agent-protocol";
import {
  MEMORY_INDEX_LINE_CLIP,
  clipLine,
  indexLineText,
} from "../lib/memory-index";
import { AUTOMATION_SOURCES } from "../validations/conversation";
import { searchMemories } from "./agent-memory-service";
import { buildContinuityBridge, buildOpenPromiseNote } from "./turn-service";

/**
 * The turn-start memory context (step 8, §3.8): a delivery-only prepend the
 * supervisor concatenates ahead of the message — never stored, never in the
 * transcript. Composed at DISPATCH time (the work-poll's "current truth"
 * law), so a dashboard edit is live from the very next turn.
 *
 * Two layers: the INDEX (every memory as one `- key: description` line — the
 * map is always in context, so recall never depends on the model remembering
 * to ask) and, when retrieval is confident, up to MEMORY_INJECT_MAX snippet
 * blocks for the incoming message. Bounded by construction: per-line clips,
 * an overflow line naming what was dropped, and a final hard slice at
 * MAX_TURN_CONTEXT_CHARS as the last resort.
 */

/** Snippets injected per turn, and the normalized-rank floor below which
 * retrieval is not confident enough to speak. The floor is a noise gate, not
 * calibrated relevance — the index above it is the primary recall path, so a
 * false negative costs a tool call, never the memory. */
export const MEMORY_INJECT_MAX = 3;
export const MEMORY_INJECT_RANK_FLOOR = 0.1;

/** Per-snippet and index-block budgets (chars). Worst case — full index +
 * max snippets + framing — stays well under MAX_TURN_CONTEXT_CHARS. */
export const MEMORY_INJECT_SNIPPET_MAX_CHARS = 800;
export const MEMORY_INDEX_MAX_CHARS = 6_000;
// The line clip + derivation moved to lib/memory-index (step 9): the file
// projection's memory/index.md shares them, so the two indexes can never
// disagree.
export { MEMORY_INDEX_LINE_CLIP } from "../lib/memory-index";

/** How much of the incoming message seeds retrieval. */
const RETRIEVAL_QUERY_MAX_CHARS = 2_000;

const INDEX_HEADER =
  "[Your memory — what you have saved so far. Bodies are not included; read one with memory_get, or search with memory_search. A dashboard edit is live from your next read:]";
const SNIPPETS_HEADER = "[Possibly relevant to this message:]";
const FOOTER = "[End of memory]";

/** The message is now stored verbatim (the continuity bridge rides this
 * context channel, never the message), so retrieval reads the human's words
 * directly — just bound the query length. */
const retrievalQueryOf = (message: string): string =>
  message.slice(0, RETRIEVAL_QUERY_MAX_CHARS).trim();

/**
 * The turn-start MEMORY block, or null when the agent has nothing saved (an
 * empty index is per-turn noise teaching nothing the CLAUDE.md fragment
 * doesn't already).
 */
const buildMemoryContext = async (
  agentId: string,
  message: string,
): Promise<string | null> => {
  // Raw select on purpose: the index only ever needs a memory's FIRST line
  // (the null-title/description fallback), and this runs on every dispatched
  // turn — reading full bodies would be ~10MB per turn at the 100k file cap.
  // `left()` is safe here because stored content is trimmed (the first line
  // starts at byte 0) and the line clip is 160 chars.
  const memories = await db.$queryRaw<
    {
      key: string;
      title: string | null;
      description: string | null;
      contentHead: string;
    }[]
  >`
    SELECT key, title, description, left(content, 400) AS "contentHead"
    FROM agent_memories
    WHERE agent_id = ${agentId}
    ORDER BY key ASC
  `;
  if (memories.length === 0) return null;

  const lines: string[] = [];
  let used = 0;
  let dropped = 0;
  for (const memory of memories) {
    const line = `- ${clipLine(memory.key, MEMORY_INDEX_LINE_CLIP)}: ${clipLine(
      indexLineText({ ...memory, content: memory.contentHead }),
      MEMORY_INDEX_LINE_CLIP,
    )}`;
    if (used + line.length + 1 > MEMORY_INDEX_MAX_CHARS) {
      dropped += 1;
      continue;
    }
    used += line.length + 1;
    lines.push(line);
  }
  if (dropped > 0) {
    lines.push(`- …and ${dropped} more — memory_list shows all.`);
  }

  const query = retrievalQueryOf(message);
  let snippetBlock = "";
  if (query.length > 0) {
    const hits = (
      await searchMemories(agentId, query, MEMORY_INJECT_MAX)
    ).filter((hit) => hit.rank >= MEMORY_INJECT_RANK_FLOOR);
    if (hits.length > 0) {
      snippetBlock = [
        SNIPPETS_HEADER,
        ...hits.map(
          (hit) =>
            `### ${clipLine(hit.key, MEMORY_INDEX_LINE_CLIP)}\n${clipLine(
              hit.snippet,
              MEMORY_INJECT_SNIPPET_MAX_CHARS,
            )}`,
        ),
      ].join("\n");
    }
  }

  const context = [
    INDEX_HEADER,
    lines.join("\n"),
    ...(snippetBlock ? [snippetBlock] : []),
    FOOTER,
  ].join("\n");
  // The last-resort guard: the budgets above hold this by construction, and
  // the wire schema would reject an overrun outright (truncate at the
  // sender — the transport law).
  return context.slice(0, MAX_TURN_CONTEXT_CHARS);
};

/**
 * The delivery-only context for one turn (step 8, §3.8): a prepend the
 * supervisor concatenates ahead of the message — NEVER stored, never in the
 * transcript, so `turn.message` stays the human's exact words. Composed at
 * DISPATCH ("current truth"), so a dashboard edit or a just-landed report is
 * live from this very turn.
 *
 * Two independent blocks: MEMORY (the agent's saved knowledge) and, for a
 * HUMAN turn only, the step-7 continuity BRIDGE (what automated runs
 * delivered here since the last human message — so "what was that?" resolves).
 * A cron/watch RUN turn gets memory but no bridge. Returns null only when both
 * are empty. Callers own failure isolation: a throwing builder must ship the
 * turn WITHOUT context, never block it.
 */
export const buildTurnContext = async (
  agentId: string,
  conversationId: string,
  turnId: string,
  message: string,
): Promise<string | null> => {
  // The bridge is human-only and windowed to this turn's own moment, so it
  // needs the turn's source + createdAt (one indexed lookup at dispatch).
  const turn = await db.turn.findUnique({
    where: { id: turnId },
    select: { createdAt: true, source: true },
  });
  const isHuman =
    turn !== null &&
    !(AUTOMATION_SOURCES as readonly string[]).includes(turn.source);

  // The two are mirror images, and exactly one applies. A HUMAN turn needs
  // the bridge: what landed while they were away, which they may be
  // referring to. A WAKE needs the opposite — it arrives with the
  // platform's instruction and no conversation at all, so it gets the
  // agent's own last reply, which is where an unfinished promise lives.
  const [memory, bridge, promise] = await Promise.all([
    buildMemoryContext(agentId, message),
    isHuman ? buildContinuityBridge(conversationId, turn.createdAt) : null,
    isHuman || turn === null
      ? null
      : buildOpenPromiseNote(conversationId, turn.createdAt),
  ]);
  if (!memory && !bridge && !promise) return null;

  // Memory first (standing knowledge); the bridge or the promise note sits
  // NEAREST the message — it is the immediate "what just landed" the person
  // is most likely referring to, or the commitment the wake must honor.
  return [memory, bridge, promise]
    .filter((block): block is string => block !== null)
    .join("\n\n")
    .slice(0, MAX_TURN_CONTEXT_CHARS);
};
