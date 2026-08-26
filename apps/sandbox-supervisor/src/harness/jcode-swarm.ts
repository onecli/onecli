import { createConnection } from "node:net";
import { z } from "zod";
import type {
  HarnessBackgroundTask,
  HarnessBackgroundTasks,
} from "@onecli/agent-protocol";
import { log } from "../log";

/**
 * jcode's swarm-helper roster, read over the daemon's LEGACY socket — the
 * only place helper lifecycle is externally visible at the pinned version
 * (verified against v0.78.1 source; re-verified byte-identical at the
 * v0.81.1 pin — `client_comm_context.rs` and `AgentInfo` unchanged): the
 * api-bridge's translator drops every swarm frame (`translate.rs` catch-all),
 * while `comm_list` is a lightweight one-shot control request the daemon
 * serves pre-subscribe on `<runtime>/jcode.sock` — write one JSON line, read
 * an `ack {id}` then the substantive reply, and the daemon closes the
 * connection (`client_lifecycle.rs`, `client_lightweight_control.rs` —
 * live-verified: the ack ALWAYS precedes the reply). Like
 * jcode-background.ts, everything vendor-format-specific lives HERE — the
 * generic observer never sees a socket (invariant 9). Every jcode bump must
 * re-verify these shapes; the binary pin test is the tripwire.
 *
 * Why mirror at all: helpers are full jcode sessions the platform otherwise
 * cannot see — no keep-awake, no watch, no turn-end safety net, no
 * lost-sweep. Mirroring them as observed background tasks buys all four with
 * zero changes outside this adapter.
 *
 * Deliberate non-mechanisms (audit-proven): NEVER subscribe/attach to a
 * helper session for a live stream — an observer disconnect tears the
 * session down (`client_disconnect_cleanup.rs`) and the event-sender
 * registration breaks comm-reply wakes; both are structural and version-
 * independent. (A third reason — attachment enabling daemon self-wake turns
 * on the helper — is defused under external wake ownership, but the first
 * two carry the rule alone.) Roster polling only; the completion report IS
 * the output.
 *
 * Facts that shape the mapping (v0.78.1 source; re-verified at v0.81.1):
 * - A headless member is inserted with status `ready` BEFORE its startup
 *   turn runs (`headless.rs`), then flips `running` → `ready|failed` with
 *   `latest_completion_report` set. So bare `ready` is terminal only once a
 *   report exists or the member was seen running — otherwise it is the
 *   pre-turn window, and mapping it terminal would freeze the mirror via the
 *   observer's terminal-seen guard.
 * - `assign_task` / DM flows can re-run a helper AFTER it reported. The
 *   observer is done with a ref once terminal, so a re-run gets a fresh
 *   GENERATION ref (`<session_id>~2`, `~3`, …) — a new observed entry with
 *   its own keep-awake and net coverage.
 * - `comm_stop` removes a member from the roster immediately and the idle
 *   reap removes finished ones after ~30min, so a running ref vanishing IS a
 *   termination — but only a round where every lead's query succeeded may
 *   say so (a transient dial failure must never fake a termination).
 * - Two conversations sharing this container share the daemon's swarm, so
 *   both leads return one roster; the union dedups by session id. First
 *   sight anchors the observed entry's context (the observer's rule) — with
 *   two live leads that may be the sibling conversation's turn, which is
 *   the same agent and self-heals at the entry level.
 */

const memberSchema = z
  .object({
    session_id: z.string().min(1),
    friendly_name: z.string().nullish(),
    status: z.string().nullish(),
    detail: z.string().nullish(),
    task_label: z.string().nullish(),
    is_headless: z.boolean().nullish(),
    latest_completion_report: z.string().nullish(),
    status_age_secs: z.number().int().nonnegative().nullish(),
  })
  .passthrough();

const replySchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("comm_members"),
      id: z.number(),
      members: z.array(z.unknown()),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("error"),
      id: z.number(),
      message: z.string(),
    })
    .passthrough(),
]);

/** The daemon's swarm gate is a working-dir property; a lead outside it gets
 * exactly this refusal, which for the mirror means "no helpers exist". */
const NOT_IN_A_SWARM = "Not in a swarm";

/** One reply line: a real roster is small; a bigger line is not jcode's. */
const MAX_REPLY_BYTES = 1_000_000;
/** A local unix-socket one-shot answers in microseconds; a daemon that takes
 * longer is wedged, and the 1s observer clock must never back up behind it. */
const DIAL_TIMEOUT_MS = 750;
/** Bound per-poll work; the enforced worker cap is 8, this is headroom. */
const MAX_MEMBERS_PER_POLL = 64;
/** Leads are live conversations in THIS container — a handful, ever. */
const MAX_LEADS_PER_POLL = 16;
/** The wire schema caps ProcessState.ref at 100 chars; session ids are
 * ~45-55, so this only ever fires on a vendor format change. */
const MAX_REF_CHARS = 100;
/** Completion reports ride outputDelta into the tail ring; cap like the
 * bash feed's per-poll delta. */
const MAX_REPORT_CHARS = 64_000;
const MAX_COMMAND_CHARS = 200;
/** status_age_secs is vendor-reported; clamp it so a forged/buggy value can
 * never push the derived start time outside Date's representable range (a
 * RangeError here would dark the whole mirror). Ten years is beyond any
 * container's life. */
const MAX_STATUS_AGE_SECS = 315_360_000;
/** Warn-dedup bound: message text can vary per failure (and is partly
 * vendor/agent-influenced), so the Set must not grow for the container's
 * life. */
const MAX_WARNED_MESSAGES = 100;
const MAX_WARN_CHARS = 300;

/** Roster statuses that mean "the helper is doing or about to do work". */
const RUNNING_STATUSES = new Set([
  "running",
  "running_stale",
  "queued",
  "streaming",
  "thinking",
]);

type Mapped = {
  status: "running" | "exited" | "stopped";
  error?: string;
};

interface SessionTrack {
  /** Re-run counter: ref = session_id for gen 1, `<session_id>~<gen>` after. */
  generation: number;
  /** ISO start of the CURRENT generation (first sight / re-run detection). */
  startedAt: string;
  /** Whether this generation was ever observed in a running-ish status. */
  seenRunning: boolean;
  /** Terminal state already emitted for the current generation. */
  terminal: boolean;
  /** ISO end, cached at terminal first-sight so snapshots stay stable. */
  endedAt?: string;
  /** The exact report text already emitted as outputDelta (any generation). */
  emittedReport?: string;
  /** Last mapped snapshot, replayed while the member stays in the roster. */
  lastSnapshot?: HarnessBackgroundTask;
}

/** One comm_list round-trip; resolves the parsed reply or rejects. */
const requestCommList = (
  socketPath: string,
  requestId: number,
  sessionId: string,
): Promise<z.infer<typeof replySchema>> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (err: Error | null, reply?: z.infer<typeof replySchema>) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(reply as z.infer<typeof replySchema>);
    };
    socket.setTimeout(DIAL_TIMEOUT_MS, () =>
      finish(new Error("comm_list timed out")),
    );
    socket.on("error", (err) => finish(err));
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({ type: "comm_list", id: requestId, session_id: sessionId })}\n`,
      );
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > MAX_REPLY_BYTES) {
        finish(new Error("comm_list reply over the size cap"));
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline !== -1 && !settled) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const frame: unknown = JSON.parse(line);
          // Every request is ACKED (`{"type":"ack","id"}`) before its
          // substantive reply (client_lightweight_control.rs) — skip past it.
          if (
            frame !== null &&
            typeof frame === "object" &&
            (frame as { type?: unknown }).type === "ack"
          ) {
            newline = buffer.indexOf("\n");
            continue;
          }
          const reply = replySchema.parse(frame);
          if (reply.id !== requestId) {
            finish(new Error("comm_list reply id mismatch"));
            return;
          }
          finish(null, reply);
        } catch (error) {
          finish(new Error(`comm_list reply unparseable: ${String(error)}`));
        }
        return;
      }
    });
    socket.on("close", () =>
      finish(new Error("comm_list socket closed early")),
    );
  });

const mapStatus = (
  status: string,
  report: string | undefined,
  seenRunning: boolean,
  detail: string | undefined,
  warnOnce: (message: string) => void,
): Mapped => {
  if (RUNNING_STATUSES.has(status)) return { status: "running" };
  if (status === "ready") {
    // Terminal only once the work is provably done — see the module header.
    if (report || seenRunning) return { status: "exited" };
    return { status: "running" };
  }
  if (status === "completed") return { status: "exited" };
  if (status === "failed") {
    return { status: "exited", error: detail || "helper failed" };
  }
  if (status === "crashed")
    return { status: "exited", error: "helper crashed" };
  if (status === "stopped") return { status: "stopped" };
  // A vendor vocabulary change: hold the mirror running (keep-awake keeps the
  // box alive; the reap + disappearance synthesis is the backstop) and say so.
  warnOnce(`unknown swarm member status "${status}"`);
  return { status: "running" };
};

export const createJcodeSwarmTasks = (deps: {
  /** The legacy daemon socket, once the instance has launched. */
  legacySocketPath: () => string | undefined;
  /** Live lead session refs (one per conversation connection). */
  leadRefs: () => string[];
}): HarnessBackgroundTasks => {
  const tracks = new Map<string, SessionTrack>();
  const warned = new Set<string>();
  let requestCounter = 0;

  const warnOnce = (message: string): void => {
    const clipped = message.slice(0, MAX_WARN_CHARS);
    if (warned.has(clipped) || warned.size >= MAX_WARNED_MESSAGES) return;
    warned.add(clipped);
    log("warn", "swarm roster mirror", { detail: clipped });
  };

  return {
    async poll(): Promise<HarnessBackgroundTask[]> {
      const socketPath = deps.legacySocketPath();
      const leads = deps.leadRefs().slice(0, MAX_LEADS_PER_POLL);
      if (!socketPath || leads.length === 0) return [];

      let roundComplete = true;
      /** At least one lead returned a REAL roster this round. A round made
       * only of "Not in a swarm" refusals is a valid empty state for new
       * mirrors, but it must never terminate helpers we have already seen —
       * the refusal prefix is vendor text, and betting live keep-awake on
       * its semantics staying put would be a silent-stop trap. */
      let sawRoster = false;
      const rosterBySession = new Map<string, z.infer<typeof memberSchema>>();
      const replies = await Promise.allSettled(
        leads.map((lead) => {
          requestCounter += 1;
          return requestCommList(socketPath, requestCounter, lead);
        }),
      );
      for (const settled of replies) {
        if (settled.status === "rejected") {
          roundComplete = false;
          warnOnce(`comm_list failed: ${String(settled.reason)}`);
          continue;
        }
        const reply = settled.value;
        if (reply.type === "error") {
          // The no-swarm refusal is a normal empty roster; anything else is a
          // failed query and must not be read as "the helpers are gone".
          if (!reply.message.startsWith(NOT_IN_A_SWARM)) {
            roundComplete = false;
            warnOnce(`comm_list error: ${reply.message}`);
          }
          continue;
        }
        sawRoster = true;
        for (const raw of reply.members) {
          const member = memberSchema.safeParse(raw);
          if (!member.success) {
            warnOnce("unparseable swarm member in roster");
            continue;
          }
          if (member.data.is_headless !== true) continue; // leads/attached members
          rosterBySession.set(member.data.session_id, member.data);
          if (rosterBySession.size >= MAX_MEMBERS_PER_POLL) break;
        }
      }

      const tasks: HarnessBackgroundTask[] = [];
      const nowMs = Date.now();

      for (const [sessionId, member] of rosterBySession) {
        const status = member.status ?? "";
        const report =
          member.latest_completion_report?.slice(0, MAX_REPORT_CHARS) ||
          undefined;
        const existing = tracks.get(sessionId);
        let track: SessionTrack;
        if (!existing) {
          track = {
            generation: 1,
            startedAt: new Date(
              nowMs -
                Math.min(member.status_age_secs ?? 0, MAX_STATUS_AGE_SECS) *
                  1000,
            ).toISOString(),
            seenRunning: false,
            terminal: false,
          };
        } else if (
          existing.terminal &&
          (RUNNING_STATUSES.has(status) ||
            // A re-run finished BETWEEN polls: all we see is `ready` with a
            // report that is not the one already delivered.
            (status === "ready" &&
              report !== undefined &&
              report !== existing.emittedReport))
        ) {
          // A helper re-running after it reported is NEW work: fresh
          // generation, fresh observed entry (the observer is done with a
          // terminal ref). The emitted report carries over so an unchanged
          // roster report is never re-emitted as new output.
          track = {
            generation: existing.generation + 1,
            startedAt: new Date(nowMs).toISOString(),
            seenRunning: false,
            terminal: false,
            emittedReport: existing.emittedReport,
          };
        } else {
          track = existing;
        }
        tracks.set(sessionId, track);

        const ref =
          track.generation === 1
            ? sessionId
            : `${sessionId}~${track.generation}`;
        if (ref.length > MAX_REF_CHARS) {
          warnOnce(
            `swarm member ref over ${MAX_REF_CHARS} chars; not mirrored`,
          );
          continue;
        }

        // A terminal generation stays terminal while the member idles in the
        // roster: replay the cached snapshot (the observer skips it anyway).
        if (track.terminal) {
          if (track.lastSnapshot) tasks.push(track.lastSnapshot);
          continue;
        }

        const mapped = mapStatus(
          status,
          report,
          track.seenRunning,
          member.detail ?? undefined,
          warnOnce,
        );
        // Keyed on the ROSTER status, never the mapped one: pre-turn `ready`
        // maps to running for the mirror, but treating it as "seen running"
        // would terminalize a helper whose startup turn merely took >1 poll —
        // a false exited row the net can never cover.
        if (RUNNING_STATUSES.has(status)) track.seenRunning = true;

        const label =
          member.task_label?.trim() ||
          member.detail?.trim() ||
          "(helper agent)";
        const name = member.friendly_name?.trim();
        const command = `swarm helper${name ? ` ${name}` : ""}: ${label}`.slice(
          0,
          MAX_COMMAND_CHARS,
        );

        let outputDelta: string | undefined;
        if (report && track.emittedReport !== report) {
          track.emittedReport = report;
          outputDelta = report;
        }

        if (mapped.status !== "running") {
          track.terminal = true;
          track.endedAt = new Date(nowMs).toISOString();
        }

        const snapshot: HarnessBackgroundTask = {
          ref,
          command,
          ...(name ? { name } : {}),
          status: mapped.status,
          ...(mapped.error ? { error: mapped.error } : {}),
          startedAt: track.startedAt,
          ...(track.endedAt ? { endedAt: track.endedAt } : {}),
          // The wake is the turn-end safety net + the lead's own awaiting —
          // a per-helper always-wake would double-report every helper the
          // lead already collected in-turn.
          wantsWake: false,
        };
        // The cached snapshot is STATE; outputDelta is a one-poll delta and
        // must never ride a terminal replay.
        track.lastSnapshot = snapshot;
        tasks.push(outputDelta ? { ...snapshot, outputDelta } : snapshot);
      }

      // Disappearance IS termination (stop/reap remove roster rows) — but
      // only a fully-successful round may say so.
      for (const [sessionId, track] of tracks) {
        if (rosterBySession.has(sessionId)) continue;
        if (!roundComplete || !sawRoster) continue;
        if (!track.terminal) {
          const ref =
            track.generation === 1
              ? sessionId
              : `${sessionId}~${track.generation}`;
          tasks.push({
            ref,
            command: track.lastSnapshot?.command ?? "swarm helper",
            ...(track.lastSnapshot?.name
              ? { name: track.lastSnapshot.name }
              : {}),
            status: "stopped",
            error: "removed from the swarm roster",
            startedAt: track.startedAt,
            endedAt: new Date(nowMs).toISOString(),
            wantsWake: false,
          });
        }
        tracks.delete(sessionId);
      }

      return tasks;
    },
  };
};
