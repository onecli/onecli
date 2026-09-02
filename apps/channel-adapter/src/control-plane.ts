import { z } from "zod";
import {
  adapterConfigResponseSchema,
  adapterCursorResponseSchema,
  adapterDecisionResponseSchema,
  adapterIngestResponseSchema,
  adapterPromptClaimResponseSchema,
  adapterReachDecisionResponseSchema,
  adapterRegisterResponseSchema,
  adapterTranscriptResponseSchema,
  adapterUnsettledPromptsResponseSchema,
  adapterWorkResponseSchema,
  type AdapterConfigResponse,
  type AdapterDecisionRequest,
  type AdapterDecisionResponse,
  type AdapterIngestRequest,
  type AdapterIngestResponse,
  type AdapterReachDecisionRequest,
  type AdapterReachDecisionResponse,
  type AdapterWorkResponse,
} from "@onecli/agent-protocol";

/**
 * The control-plane HTTP client — plain `fetch` + zod-parsed responses, the
 * `apps/runner/src/control-plane.ts` shape: every response is parsed, never
 * cast, so a contract drift fails loudly here instead of somewhere deep in a
 * poll loop.
 */

const DEFAULT_TIMEOUT_MS = 15_000;

/** An HTTP error the control plane ANSWERED — distinct from transport
 * failures so callers can retry the network and stop on a refusal. */
export class ControlPlaneError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ControlPlaneError";
  }
}

export interface ControlPlaneClient {
  register(name: string): Promise<string>;
  // No heartbeat method on purpose: the adapter-auth middleware touches
  // `lastSeenAt` on every authenticated call, and the config/work polls run
  // continuously — the polls ARE the heartbeat (the `/heartbeat` route
  // exists for a future quiet mode).
  /** Returns null on a 304 (etag matched — nothing changed). */
  getConfig(etag: string | null): Promise<AdapterConfigResponse | null>;
  getWork(): Promise<AdapterWorkResponse>;
  ingest(request: AdapterIngestRequest): Promise<AdapterIngestResponse>;
  decide(request: AdapterDecisionRequest): Promise<AdapterDecisionResponse>;
  /** Forward a reach-card click; authorization is control-plane-side. */
  decideReach(
    request: AdapterReachDecisionRequest,
  ): Promise<AdapterReachDecisionResponse>;
  claimPrompt(input: {
    approvalId: string;
    presenceId: string;
    externalThreadId: string;
    /** ISO string or null — the gateway deadline persisted for restart re-arm. */
    expiresAt: string | null;
  }): Promise<boolean>;
  recordPromptMessage(
    approvalId: string,
    externalMessageRef: string,
  ): Promise<void>;
  settlePrompt(approvalId: string, state: "decided" | "expired"): Promise<void>;
  listUnsettledPrompts(): Promise<
    z.infer<typeof adapterUnsettledPromptsResponseSchema>["prompts"]
  >;
  /** `turnId` lets the control plane clear the turn's reaction receipt on a
   * CAS win — the answer is posting, so the "seen" reaction comes off. */
  advanceCursor(
    linkId: string,
    expect: string | null,
    next: string,
    turnId?: string,
  ): Promise<boolean>;
  reportApprovalHealth(presenceId: string, healthy: boolean): Promise<void>;
  /** The proactive credential sweep — staleness is decided server-side. */
  rotateIntegrations(): Promise<{ rotated: number; failed: number }>;
  readTranscript(
    conversationId: string,
    since: number | undefined,
  ): Promise<z.infer<typeof adapterTranscriptResponseSchema>>;
}

export const createControlPlane = (options: {
  baseUrl: string;
  token: string;
}): ControlPlaneClient => {
  // The bearer starts as the anchor and becomes the minted per-instance
  // credential once registration answers one (an OLD control plane mints
  // nothing — the anchor then stays the bearer, the legacy shared identity).
  let bearer = options.token;
  // The name the last successful registration used — the base for the
  // displaced-twin recovery below. Null until first registration: a 401
  // before that is a real refusal (bad anchor), never a displacement.
  let registeredName: string | null = null;
  let recovery: Promise<boolean> | null = null;

  const register = async (name: string): Promise<string> => {
    // Registration ALWAYS presents the anchor — it is the membership proof;
    // the minted bearer is this instance's identity, never its passport.
    const response = await fetch(
      `${options.baseUrl}/v1/channel-adapter/register`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name, perInstance: true }),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      throw new ControlPlaneError(
        response.status,
        `control plane answered ${response.status} for /register`,
      );
    }
    const parsed = adapterRegisterResponseSchema.parse(await response.json());
    bearer = parsed.token ?? options.token;
    registeredName = name;
    return parsed.adapterId;
  };

  /**
   * A 401 AFTER a successful mint means the minted credential was displaced —
   * a same-named twin re-registered and took the row. Re-register ONCE under
   * a self-suffixed name (fresh row, fresh mint) so two same-named live
   * instances converge to distinct identities after one displacement each —
   * never a flip-flop storm. Single-flighted: every 401-ing loop funnels into
   * one re-register.
   */
  const recoverFromDisplacement = async (): Promise<boolean> => {
    const baseName = registeredName;
    if (!baseName) return false;
    recovery ??= (async () => {
      try {
        const suffix = Math.floor(Math.random() * 0xffff)
          .toString(16)
          .padStart(4, "0");
        await register(`${baseName}-${suffix}`);
        return true;
      } catch {
        return false;
      } finally {
        // Allow a FUTURE displacement to recover again; concurrent callers of
        // THIS one all shared the settled promise.
        queueMicrotask(() => {
          recovery = null;
        });
      }
    })();
    return recovery;
  };

  const call = async <T extends z.ZodType>(
    method: "GET" | "POST",
    path: string,
    schema: T,
    init?: { body?: unknown; headers?: Record<string, string> },
  ): Promise<z.infer<T>> => {
    const doFetch = () =>
      fetch(`${options.baseUrl}/v1${path}`, {
        method,
        headers: {
          authorization: `Bearer ${bearer}`,
          ...(init?.body !== undefined && {
            "content-type": "application/json",
          }),
          ...init?.headers,
        },
        ...(init?.body !== undefined && { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
    let response = await doFetch();
    if (response.status === 401 && (await recoverFromDisplacement())) {
      response = await doFetch();
    }
    if (!response.ok) {
      throw new ControlPlaneError(
        response.status,
        `control plane answered ${response.status} for ${path}`,
      );
    }
    return schema.parse(await response.json()) as z.infer<T>;
  };

  return {
    register,

    async getConfig(etag) {
      const doFetch = () =>
        fetch(`${options.baseUrl}/v1/channel-adapter/config`, {
          headers: {
            authorization: `Bearer ${bearer}`,
            ...(etag && { "if-none-match": etag }),
          },
          signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        });
      let response = await doFetch();
      if (response.status === 401 && (await recoverFromDisplacement())) {
        response = await doFetch();
      }
      if (response.status === 304) return null;
      if (!response.ok) {
        throw new ControlPlaneError(
          response.status,
          `control plane answered ${response.status} for /config`,
        );
      }
      return adapterConfigResponseSchema.parse(await response.json());
    },

    getWork: () =>
      call("GET", "/channel-adapter/work", adapterWorkResponseSchema),

    ingest: (request) =>
      call("POST", "/channel-adapter/ingest", adapterIngestResponseSchema, {
        body: request,
      }),

    decide: (request) =>
      call("POST", "/channel-adapter/decision", adapterDecisionResponseSchema, {
        body: request,
      }),

    decideReach: (request) =>
      call(
        "POST",
        "/channel-adapter/reach-decision",
        adapterReachDecisionResponseSchema,
        { body: request },
      ),

    async claimPrompt(input) {
      const parsed = await call(
        "POST",
        "/channel-adapter/prompts/claim",
        adapterPromptClaimResponseSchema,
        { body: input },
      );
      return parsed.claimed;
    },

    async recordPromptMessage(approvalId, externalMessageRef) {
      await call(
        "POST",
        "/channel-adapter/prompts/message",
        z.object({ ok: z.boolean() }),
        { body: { approvalId, externalMessageRef } },
      );
    },

    async settlePrompt(approvalId, state) {
      await call(
        "POST",
        "/channel-adapter/prompts/settle",
        z.object({ prompt: z.unknown() }),
        { body: { approvalId, state } },
      );
    },

    async listUnsettledPrompts() {
      const parsed = await call(
        "GET",
        "/channel-adapter/prompts/unsettled",
        adapterUnsettledPromptsResponseSchema,
      );
      return parsed.prompts;
    },

    async advanceCursor(linkId, expect, next, turnId) {
      const parsed = await call(
        "POST",
        "/channel-adapter/cursor",
        adapterCursorResponseSchema,
        { body: { linkId, expect, next, ...(turnId && { turnId }) } },
      );
      return parsed.advanced;
    },

    async reportApprovalHealth(presenceId, healthy) {
      await call(
        "POST",
        "/channel-adapter/approval-health",
        z.object({ ok: z.boolean() }),
        { body: { presenceId, healthy } },
      );
    },

    rotateIntegrations: () =>
      call(
        "POST",
        "/channel-adapter/rotate-integrations",
        z.object({ rotated: z.number().int(), failed: z.number().int() }),
        { body: {} },
      ),

    readTranscript: (conversationId, since) =>
      call(
        "GET",
        `/channel-adapter/conversations/${encodeURIComponent(conversationId)}/events${
          since !== undefined ? `?since=${since}` : ""
        }`,
        adapterTranscriptResponseSchema,
      ),
  };
};
