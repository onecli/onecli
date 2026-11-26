import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import {
  AGENT_CONFLICT_LOG_MSG,
  AGENT_CONFLICT_REASON_EXISTING,
  AGENT_CONFLICT_REASON_FIELD,
  AGENT_CONFLICT_REASON_RACE,
  createLogAgentConflict,
} from "./agent-conflict-log";

/**
 * The agent-conflict line is the ONLY server-side record of a 409 from
 * `POST /v1/agents` (onecli/onecli-cloud#1115) — the access log records just
 * method/path/status/orgId. Two properties are load-bearing and neither is
 * visible from reading the call site:
 *
 * 1. It must EXIST in prod, where `LOG_LEVEL=warn` would drop a plain
 *    `log.info` before it is ever written (the claim-wait line's lesson).
 * 2. It must stay INFO, so it does not pollute the health check's
 *    `level >= WARN` query — the exact noise-vs-signal failure that made the
 *    issue misread normal `ensureAgent` traffic as a stuck retry loop.
 *
 * So these tests drive the REAL factory against a REAL warn-level root and
 * assert on the emitted JSON.
 */

const captured = (): { root: pino.Logger; lines: string[] } => {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  // warn root = a production api-server shape (LOG_LEVEL=warn).
  return { root: pino({ level: "warn" }, sink), lines };
};

const parsed = (line: string) => JSON.parse(line) as Record<string, unknown>;

describe("agent identifier conflict log line (#1115)", () => {
  it("CLOUD: survives prod's warn root — the pinned-info child still emits", () => {
    const { root, lines } = captured();
    const logAgentConflict = createLogAgentConflict(root, true);

    root.info("swallowed at the root level");
    logAgentConflict({
      workspaceId: "ws-1",
      identifier: "my-agent",
      reason: AGENT_CONFLICT_REASON_EXISTING,
      existingAgentId: "ag-1",
    });

    expect(lines).toHaveLength(1);
    const line = parsed(lines[0]!);
    expect(line.msg).toBe(AGENT_CONFLICT_LOG_MSG);
    expect(line.workspaceId).toBe("ws-1");
    expect(line.identifier).toBe("my-agent");
    expect(line.existingAgentId).toBe("ag-1");
    expect(line[AGENT_CONFLICT_REASON_FIELD]).toBe(
      AGENT_CONFLICT_REASON_EXISTING,
    );
  });

  it("stays INFO — a warn would land in the health check's error query", () => {
    const { root, lines } = captured();
    createLogAgentConflict(
      root,
      true,
    )({
      workspaceId: "ws-1",
      identifier: "my-agent",
      reason: AGENT_CONFLICT_REASON_EXISTING,
    });

    // pino's numeric levels: info=30, warn=40. The whole point of the line is
    // that it is an EXPECTED outcome, countable without being an alert.
    expect(parsed(lines[0]!).level).toBe(30);
  });

  it("the race arm is distinguishable from the benign ensure arm", () => {
    const { root, lines } = captured();
    const logAgentConflict = createLogAgentConflict(root, true);

    logAgentConflict({
      workspaceId: "ws-1",
      identifier: "my-agent",
      reason: AGENT_CONFLICT_REASON_RACE,
    });

    const line = parsed(lines[0]!);
    expect(line[AGENT_CONFLICT_REASON_FIELD]).toBe(AGENT_CONFLICT_REASON_RACE);
    // No id to name: the insert failed, so nothing came back. The key must be
    // ABSENT rather than undefined/null, so the field means one thing.
    expect(line).not.toHaveProperty("existingAgentId");
  });

  it("ONPREM: the operator's root level stands — nothing reads the line there", () => {
    const { root, lines } = captured();
    createLogAgentConflict(
      root,
      false,
    )({
      workspaceId: "ws-1",
      identifier: "my-agent",
      reason: AGENT_CONFLICT_REASON_EXISTING,
    });
    expect(lines).toHaveLength(0);
  });

  it("a throwing logger never breaks agent creation", () => {
    const throwing = {
      child() {
        return this;
      },
      info: () => {
        throw new Error("sink died");
      },
    } as unknown as pino.Logger;
    const logAgentConflict = createLogAgentConflict(throwing, true);
    expect(() =>
      logAgentConflict({
        workspaceId: "ws-1",
        identifier: "my-agent",
        reason: AGENT_CONFLICT_REASON_EXISTING,
      }),
    ).not.toThrow();
  });
});
