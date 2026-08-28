import type { CapabilityFragment } from "../home/renderer";
import type { PlatformToolDefinition } from "../platform-tools";

/**
 * The memory capability (step 8) — the second entry in the §3.7 registry.
 * Same two halves as crons: the instruction fragment (the memory POLICY —
 * what deserves storing and what must never be stored) and the MCP tool
 * definitions. The schemas here are the MODEL-facing contract; the control
 * plane's zod (validations/memories.ts) is the enforcement authority, and
 * the bounds are kept identical by eye — a drift fails loudly there, never
 * silently here.
 */

export const memoryFragment: CapabilityFragment = {
  id: "memory",
  title: "Memory",
  body: `You have durable memory. It lives in your home as files under
memory/ — one Markdown file per memory, memory/index.md as the generated map
— and every memory is stored on the platform, which is the source of truth:
this machine can be replaced at any moment, and memory/ is restored from the
platform, never from the machine. Conversations end; memory is what carries
across them — to tomorrow, to other chats, and to your scheduled runs.

- To save or update a memory, edit or create memory/<kebab-name>.md — file
  changes sync to the platform within seconds — or use memory_save (same
  store; content over 12,000 characters must go through the file). Save
  things worth keeping the moment you learn them: durable facts,
  preferences, corrections the person makes, decisions, and findings from
  your work — especially scheduled runs, which start with no chat history.
- Never store secrets: no passwords, tokens, API keys, or credentials of any
  kind, even if asked. Say why, and store a pointer instead ("the key lives
  in the dashboard").
- File names are stable handles: writing to an existing file updates that
  memory, with history kept. Prefer updating one good memory over piling up
  near-duplicates, and keep each memory focused — split big topics into
  linked files (an oversized or oddly-named file will NOT sync, and is
  therefore not durable).
- memory/index.md is generated — never edit it. The checksum line in each
  file's frontmatter is platform bookkeeping; you can leave it stale or
  remove it when editing, it refreshes on sync.
- Deleting a file does not delete the memory — the platform restores it. To
  retire one, overwrite it saying it is obsolete, or ask the person you work
  with to delete it in the dashboard.
- An index of your memories arrives with each message; bodies do not. Read
  the files directly, memory_get by key, memory_list for what exists, or
  memory_search when you are not sure where to look.
- Everything you save is visible and editable by the people you work with,
  in the dashboard, with full history. Their edits are live: your files
  update while you run — when what you recall and what a file says disagree,
  the file is newer.`,
};

export const memoryTools: PlatformToolDefinition[] = [
  {
    name: "memory_save",
    description:
      "Save or update a memory by key. The same key updates its content (history kept; a title or description you omit keeps its current value); a new key creates. Memories survive across conversations, sessions, and scheduled runs — this is how you remember things tomorrow. For content beyond this tool's per-save limit, write memory/<key>.md in your home instead — same store.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description:
            'Stable lowercase-with-hyphens name, e.g. "deploy-notes". Reuse a key to update that memory.',
          pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
          maxLength: 80,
        },
        content: {
          type: "string",
          description: "The memory itself, in Markdown.",
          maxLength: 12_000,
        },
        description: {
          type: "string",
          description:
            "One line saying what this memory holds — it is how you (and the person) find it in the index later.",
          maxLength: 300,
        },
        title: {
          type: "string",
          description: "Optional display title; the key is used when absent.",
          maxLength: 120,
        },
      },
      required: ["key", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_list",
    description:
      "List your memories — key, title, description, and how full your memory is. Bodies are not included; read one with memory_get.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "memory_search",
    description:
      "Search your memories by content. Returns the best matches with a short highlighted snippet each — read a full body with memory_get.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to look for, in plain words.",
          maxLength: 500,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_get",
    description:
      "Read one memory's content by key. The index in your context and memory_list show the keys. A very large memory is truncated here — memory/<key>.md in your home always has the full body.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "The memory's key.",
          maxLength: 80,
        },
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
];
