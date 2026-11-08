import { expect, test } from "vitest";
import { toolFinishedEventSchema } from "@onecli/agent-protocol";
import type { listTurns } from "@onecli/api/services/turn-service";
import { scenario, type Cx } from "../src/scenario.js";
import {
  seedAnthropicGrant,
  seedHostedAgent,
  seedTenant,
} from "../src/fixtures.js";
import {
  fetchTranscript,
  runTurn,
  type TranscriptEvent,
  type V1Client,
} from "../src/v1.js";

type LiveAuth = { mode: "oauth" | "api-key"; value: string };

const resolveLiveAuth = (
  oauthToken: string | undefined,
  apiKey: string | undefined,
): LiveAuth | null => {
  if (oauthToken !== undefined && apiKey !== undefined) {
    throw new Error(
      "Set exactly one of E2E_ANTHROPIC_OAUTH_TOKEN or E2E_ANTHROPIC_API_KEY, not both",
    );
  }
  const value = oauthToken ?? apiKey;
  if (value === undefined) return null;
  if (value.length === 0 || /\s/.test(value)) {
    throw new Error(
      "The supplied E2E Anthropic credential must be nonempty and contain no whitespace",
    );
  }
  return { mode: oauthToken !== undefined ? "oauth" : "api-key", value };
};

const LIVE_AUTH = resolveLiveAuth(
  process.env.E2E_ANTHROPIC_OAUTH_TOKEN,
  // Direct Vitest opt-in only, not a Turbo task input.
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  process.env.E2E_ANTHROPIC_API_KEY,
);
const TURN_TIMEOUT_MS = 180_000;

const liveScenario = (name: string, body: (cx: Cx) => Promise<void>): void => {
  if (LIVE_AUTH === null) {
    test.skip(`${name} (E2E_ANTHROPIC_OAUTH_TOKEN and E2E_ANTHROPIC_API_KEY unset)`, () =>
      undefined);
    return;
  }
  scenario(name, body, { timeoutMs: 1_200_000 });
};

test("live auth selection is explicit and never falls back", () => {
  expect(resolveLiveAuth(undefined, undefined)).toBeNull();
  expect(resolveLiveAuth("synthetic-oauth", undefined)).toEqual({
    mode: "oauth",
    value: "synthetic-oauth",
  });
  expect(resolveLiveAuth(undefined, "synthetic-api-key")).toEqual({
    mode: "api-key",
    value: "synthetic-api-key",
  });
  for (const [oauth, apiKey] of [
    ["synthetic-oauth", "synthetic-api-key"],
    ["", "synthetic-api-key"],
    ["synthetic-oauth", ""],
  ]) {
    expect(() => resolveLiveAuth(oauth, apiKey)).toThrow(
      "Set exactly one of E2E_ANTHROPIC_OAUTH_TOKEN or E2E_ANTHROPIC_API_KEY, not both",
    );
  }
  for (const invalid of [
    "",
    " ",
    "\t",
    "\n",
    " synthetic",
    "synthetic ",
    "syn thetic",
    "syn\rthetic",
  ]) {
    for (const mode of ["oauth", "api-key"]) {
      expect(() =>
        resolveLiveAuth(
          mode === "oauth" ? invalid : undefined,
          mode === "api-key" ? invalid : undefined,
        ),
      ).toThrow(
        "The supplied E2E Anthropic credential must be nonempty and contain no whitespace",
      );
    }
  }
});

// Text events are replacement snapshots, not deltas. Neither progress nor
// tool payloads are a user-visible final answer, even when they contain data.
const finalAnswer = (events: TranscriptEvent[], turnId: string): string => {
  let answer = "";
  for (const event of events) {
    if (event.turnId === turnId && event.type === "text") {
      expect(typeof event.payload["text"]).toBe("string");
      const text = event.payload["text"];
      if (typeof text === "string") answer = text;
    }
  }
  expect(answer.trim(), `turn ${turnId} has no durable final text`).not.toBe(
    "",
  );
  return answer;
};

// Each synthetic field is unique and each complete record must occur on ONE
// line. This accepts CSV or Markdown table presentation, not first/last-row
// samples, scattered field mentions, or a filename with no downloadable bytes.
const tableRows = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => {
    const n = String(index + 1).padStart(3, "0");
    return `record_${n},label_${n},value_${n}`;
  });

const containsEveryRow = (text: string, rows: string[]): boolean => {
  const lines = new Set(
    text.split(/\r?\n/).map((line) =>
      line
        .replace(/[|,`"*]/g, " ")
        .trim()
        .replace(/\s+/g, " "),
    ),
  );
  return rows.every((row) => lines.has(row.replaceAll(",", " ")));
};

// These generated fixture fields contain no commas, quotes, or newlines.
// Accept CSV quoting, CRLF and BOM, but not Markdown disguised as an export.
const isCompleteCsv = (text: string, rows: string[]): boolean => {
  const lines = text
    .replace(/^\uFEFF/, "")
    .trim()
    .split(/\r?\n/)
    .map((line) =>
      line
        .split(",")
        .map((field) => field.trim().replace(/^"([^"]*)"$/, "$1"))
        .join(","),
    );
  const records = new Set(lines.slice(1));
  return (
    lines[0] === "id,label,value" &&
    lines.length === rows.length + 1 &&
    rows.every((row) => records.has(row))
  );
};

const assertDelivered = async (
  v1: V1Client,
  conversationId: string,
  turnId: string,
  rows: string[],
  delivery: "inline" | "either" | "attachment" = "either",
): Promise<string[]> => {
  const answer = finalAnswer(await fetchTranscript(v1, conversationId), turnId);
  const response = await v1.json<Awaited<ReturnType<typeof listTurns>>>(
    await v1.get(`/v1/conversations/${conversationId}/turns`),
  );
  const turn = response.turns.find((row) => row.id === turnId);
  expect(turn, `missing API turn ${turnId}`).toBeDefined();
  const attachments = turn?.attachments ?? [];
  let completeDownload = false;
  for (const attachment of attachments) {
    // These must be NEW attachments bound to this API turn, never a link to
    // the preceding turn or an unbound upload masquerading as delivery.
    expect(attachment.status).toBe("bound");
    expect(attachment.direction).toBe("outbound");
    const download = await v1.get(
      `/v1/conversations/${conversationId}/attachments/${attachment.id}`,
    );
    expect(download.status).toBe(200);
    const bytes = Buffer.from(await download.arrayBuffer());
    expect(bytes.byteLength).toBe(attachment.sizeBytes);
    const complete = containsEveryRow(bytes.toString("utf8"), rows);
    expect(complete, `attachment ${attachment.id} lacks complete records`).toBe(
      true,
    );
    if (delivery === "attachment") {
      expect(attachment.name).toMatch(/\.csv$/i);
      expect(isCompleteCsv(bytes.toString("utf8"), rows)).toBe(true);
    }
    completeDownload = completeDownload || complete;
  }
  expect(
    (delivery !== "attachment" && containsEveryRow(answer, rows)) ||
      (delivery !== "inline" && completeDownload),
    `turn ${turnId} must deliver every field of every row via ${delivery} delivery; ${attachments.length} current-turn attachments; final answer: ${answer}`,
  ).toBe(true);
  return attachments.map((attachment) => attachment.id);
};

test("delivery oracle uses only the current turn's last text snapshot", () => {
  const events: TranscriptEvent[] = [
    {
      seq: 1,
      turnId: "old",
      type: "text",
      payload: { text: tableRows(4).join("\n") },
    },
    {
      seq: 2,
      turnId: "new",
      type: "tool.finished",
      payload: { text: tableRows(4).join("\n") },
    },
    {
      seq: 3,
      turnId: "new",
      type: "text",
      payload: { text: tableRows(4).join("\n") },
    },
    {
      seq: 4,
      turnId: "new",
      type: "progress",
      payload: { text: tableRows(4).join("\n") },
    },
    {
      seq: 5,
      turnId: "new",
      type: "text",
      payload: { text: "See stdout above." },
    },
  ];
  const answer = finalAnswer(events, "new");
  expect(answer).toBe("See stdout above.");
  expect(containsEveryRow(answer, tableRows(4))).toBe(false);
  expect(() => finalAnswer(events, "missing")).toThrow();
});

test("delivery oracle rejects missing or corrupted middle fields", () => {
  const rows = tableRows(100);
  expect(containsEveryRow(rows.join("\n"), rows)).toBe(true);
  expect(
    containsEveryRow(rows.join("\n").replace("label_050", "wrong"), rows),
  ).toBe(false);
  expect(
    containsEveryRow(
      rows.filter((row) => !row.startsWith("record_050")).join("\n"),
      rows,
    ),
  ).toBe(false);
  expect(containsEveryRow("The 100 rows were sent in results.csv", rows)).toBe(
    false,
  );
});

test("CSV export oracle requires the header and complete CSV records", () => {
  const rows = tableRows(4);
  expect(isCompleteCsv(["id,label,value", ...rows].join("\n"), rows)).toBe(
    true,
  );
  const quoted = ["id,label,value", ...rows]
    .map((line) =>
      line
        .split(",")
        .map((field) => `"${field}"`)
        .join(","),
    )
    .join("\r\n");
  expect(isCompleteCsv(`\uFEFF${quoted}\r\n`, rows)).toBe(true);
  expect(isCompleteCsv(rows.join("\n"), rows)).toBe(false);
  expect(
    isCompleteCsv(
      ["id,label,value", ...rows]
        .join("\n")
        .replace("record_001,", 'record_001",'),
      rows,
    ),
  ).toBe(false);
  expect(
    isCompleteCsv(
      [
        "id,label,value",
        ...rows.map((row) => `| ${row.replaceAll(",", " | ")} |`),
      ].join("\n"),
      rows,
    ),
  ).toBe(false);
  expect(
    isCompleteCsv(["id,label,value", ...rows, rows[0]].join("\n"), rows),
  ).toBe(false);
  expect(
    isCompleteCsv(
      [
        "| id | label | value |",
        ...rows.map((row) => `| ${row.replaceAll(",", " | ")} |`),
      ].join("\n"),
      rows,
    ),
  ).toBe(false);
});

const commandResults = (events: TranscriptEvent[], turnId: string) =>
  events
    .filter(
      (event) => event.turnId === turnId && event.type === "tool.finished",
    )
    .map((event) =>
      toolFinishedEventSchema.parse({ ...event.payload, type: event.type }),
    );

const generateTable = (count: number): string =>
  `awk 'BEGIN { print "id,label,value"; for (i=1; i<=${count}; i++) printf "record_%03d,label_%03d,value_%03d\\n", i,i,i }'`;

liveScenario(
  "live jcode delivers command results, repeats all rows on a new turn, and reports empty/failing/refused results truthfully",
  async (cx) => {
    const stack = await cx.startStack();
    if (stack.runner === null) throw new Error("runner expected");
    await seedTenant(cx.prisma, cx.ids);
    await seedHostedAgent(cx.prisma, cx.ids, {
      runnerId: stack.runner.runnerId,
      harness: "jcode",
    });
    if (LIVE_AUTH === null) throw new Error("Live Anthropic auth required");
    const { secretId } = await seedAnthropicGrant(cx.prisma, cx.ids, {
      value: LIVE_AUTH.value,
    });
    if (LIVE_AUTH.mode === "oauth") {
      await cx.prisma.secret.update({
        where: { id: secretId },
        data: { metadata: { authMode: "oauth" } },
      });
    }
    stack.runner.pump();
    const conversation = await stack.v1.json<{ id: string }>(
      await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
    );
    const ask = async (message: string) => {
      const turn = await runTurn(
        stack.v1,
        conversation.id,
        message,
        TURN_TIMEOUT_MS,
      );
      expect(turn.status, turn.error ?? "turn did not finish").toBe("done");
      const events = await fetchTranscript(stack.v1, conversation.id);
      return { turn, events, answer: finalAnswer(events, turn.id) };
    };

    const small = await ask(
      `Run this command: \`${generateTable(4)}\`. Show every row and field here in chat as a CSV table.`,
    );
    expect(
      commandResults(small.events, small.turn.id).some((result) =>
        containsEveryRow(result.output, tableRows(4)),
      ),
    ).toBe(true);
    await assertDelivered(
      stack.v1,
      conversation.id,
      small.turn.id,
      tableRows(4),
      "inline",
    );

    // Deliberately specify the data/format, NOT a delivery method. The model
    // must choose complete inline data or an actual send_file attachment.
    const large = await ask(
      `Run this command: \`${generateTable(100)}\`. I need the complete synthetic CSV table, all 100 rows and all three fields.`,
    );
    expect(
      commandResults(large.events, large.turn.id).some((result) =>
        containsEveryRow(result.output, tableRows(100)),
      ),
    ).toBe(true);
    const largeAttachmentIds = await assertDelivered(
      stack.v1,
      conversation.id,
      large.turn.id,
      tableRows(100),
    );

    const repeated = await ask("I cannot see it, show all rows again");
    expect(repeated.turn.id).not.toBe(large.turn.id);
    const repeatedAttachmentIds = await assertDelivered(
      stack.v1,
      conversation.id,
      repeated.turn.id,
      tableRows(100),
    );

    // Force the successful file route once, even if both prior answers
    // chose inline delivery. An inline table cannot satisfy this request.
    const exported = await ask(
      "Please export the complete 100-row table as a CSV file and attach it here so I can download it, with all three fields for every row.",
    );
    expect(exported.turn.id).not.toBe(repeated.turn.id);
    const exportedAttachmentIds = await assertDelivered(
      stack.v1,
      conversation.id,
      exported.turn.id,
      tableRows(100),
      "attachment",
    );
    const priorAttachmentIds = new Set([
      ...largeAttachmentIds,
      ...repeatedAttachmentIds,
    ]);
    expect(exportedAttachmentIds.length).toBeGreaterThan(0);
    for (const id of exportedAttachmentIds) {
      expect(priorAttachmentIds.has(id), `export reused attachment ${id}`).toBe(
        false,
      );
    }

    const empty = await ask(
      "Run `printf ''` and report the result of this command only. Do not reuse the previous table.",
    );
    expect(
      commandResults(empty.events, empty.turn.id).some((result) =>
        result.input?.includes("printf"),
      ),
    ).toBe(true);
    expect(empty.answer).toMatch(
      /empty|no (?:rows|output|data)|nothing|zero|0 (?:rows|bytes)/i,
    );
    expect(empty.answer).not.toContain("record_");

    const failed = await ask(
      "Run `sh -c 'echo SYNTHETIC_COMMAND_FAILURE >&2; exit 23'` exactly once. Report whether it succeeded and its exit code. Do not repair or rerun it.",
    );
    expect(
      commandResults(failed.events, failed.turn.id).some((result) =>
        result.output.includes("SYNTHETIC_COMMAND_FAILURE"),
      ),
    ).toBe(true);
    expect(failed.answer).toMatch(/fail|error|unsuccessful|did not succeed/i);
    expect(failed.answer).toMatch(/\b23\b/);
    expect(failed.answer).not.toContain("record_");

    // A nonexistent synthetic path exercises a real refusal without touching
    // containment/size/count fences (those belong to send-file.test.ts).
    const refused = await ask(
      "Use send_file to send /workspace/output-delivery-does-not-exist.csv without creating it. If the tool is unavailable or refuses, tell me explicitly that no file was delivered. Do not create a replacement.",
    );
    expect(refused.answer).toMatch(
      /not (?:sent|delivered|attached)|no file.{0,40}(?:sent|delivered|attached)|cannot|could not|unable|does not exist|not found|unavailable/i,
    );
    expect(refused.answer).not.toMatch(
      /(?:successfully|have|has been) (?:sent|delivered|attached)|\[.*?\]\(.*?\)/i,
    );
    const turns = await stack.v1.json<Awaited<ReturnType<typeof listTurns>>>(
      await stack.v1.get(`/v1/conversations/${conversation.id}/turns`),
    );
    expect(
      turns.turns.find((turn) => turn.id === refused.turn.id)?.attachments,
    ).toEqual([]);
    await stack.runner.pausePump();
  },
);
