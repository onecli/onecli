import { z } from "zod";

/**
 * The adapter's thin Slack Web API client — runtime methods only (the
 * control plane has its own sibling for the attach-time calls). Typed,
 * zod-parsed `fetch`; no `@slack/*` dependency (the decision and its
 * reasoning live in the step-6 plan: ~a dozen simple POSTs, and we must own
 * ack/refresh timing precisely anyway).
 */

const apiBase = (): string =>
  process.env.SLACK_API_BASE_URL ?? "https://slack.com/api";

const CALL_TIMEOUT_MS = 15_000;

export class SlackApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly code: string,
  ) {
    super(`Slack ${method} refused: ${code}`);
    this.name = "SlackApiError";
  }
}

const okEnvelope = z.object({ ok: z.boolean(), error: z.string().optional() });

const slackCall = async <T extends z.ZodType>(
  method: string,
  token: string,
  form: Record<string, string>,
  schema: T,
): Promise<z.infer<T>> => {
  const response = await fetch(`${apiBase()}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=utf-8",
      authorization: `Bearer ${token}`,
    },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Slack ${method} answered HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  const envelope = okEnvelope.parse(body);
  if (!envelope.ok) {
    throw new SlackApiError(method, envelope.error ?? "unknown_error");
  }
  return schema.parse(body);
};

export const connectionsOpen = (appToken: string) =>
  slackCall(
    "apps.connections.open",
    appToken,
    {},
    z.object({ url: z.string().min(1) }),
  );

const postedMessage = z.object({
  channel: z.string().min(1),
  ts: z.string().min(1),
});

/**
 * Bot tokens whose install predates `chat:write.customize` — the icon
 * attempt came back `missing_scope` once, so later posts skip it instead of
 * paying a doomed extra chat.postMessage per message. Time-bounded: Slack
 * KEEPS the same xoxb token across a scope-granting reinstall (the healing
 * move), so a permanent memo would strip icons forever after the user fixed
 * the install — the verdict re-probes once per window (one cheap refused
 * post), and the fix (reinstall) is the user's move, not ours.
 */
const ICONLESS_RETRY_MS = 60 * 60 * 1000;
const iconlessBotTokens = new Map<string, number>();

const iconlessMemoized = (botToken: string): boolean => {
  const at = iconlessBotTokens.get(botToken);
  return at !== undefined && Date.now() - at < ICONLESS_RETRY_MS;
};

export const resetIconlessBotTokensForTests = (): void => {
  iconlessBotTokens.clear();
};

export const postMessage = async (
  botToken: string,
  input: { channel: string; text: string; threadTs?: string; iconUrl?: string },
) => {
  const form = {
    channel: input.channel,
    text: input.text,
    ...(input.threadTs && { thread_ts: input.threadTs }),
  };
  if (input.iconUrl && !iconlessMemoized(botToken)) {
    try {
      return await slackCall(
        "chat.postMessage",
        botToken,
        // The agent's avatar. Needs `chat:write.customize` — a PRE-EXISTING
        // install predating the scope fails the whole post (`missing_scope`),
        // so that one error retries plain: the answer must land even when
        // the icon cannot.
        { ...form, icon_url: input.iconUrl },
        postedMessage,
      );
    } catch (err) {
      if (!(err instanceof SlackApiError) || err.code !== "missing_scope") {
        throw err;
      }
      iconlessBotTokens.set(botToken, Date.now());
    }
  }
  return slackCall("chat.postMessage", botToken, form, postedMessage);
};

/**
 * Block Kit message post — the approval card and the connect-cards answer.
 * The TRUST rule: button URLs and action ids are built ONLY from server-side
 * config and template text, never model prose; section/context TEXT may
 * carry model-authored answers, but only after `markdownToMrkdwn` /
 * `escapeSlackText` neutralized Slack's control syntax.
 */
export const postBlocks = async (
  botToken: string,
  input: {
    channel: string;
    text: string;
    blocks: unknown[];
    threadTs?: string;
    iconUrl?: string;
  },
) => {
  const form = {
    channel: input.channel,
    text: input.text,
    blocks: JSON.stringify(input.blocks),
    ...(input.threadTs && { thread_ts: input.threadTs }),
  };
  if (input.iconUrl && !iconlessMemoized(botToken)) {
    try {
      // Same missing_scope fallback as postMessage — the card must land
      // even on an install predating `chat:write.customize`.
      return await slackCall(
        "chat.postMessage",
        botToken,
        { ...form, icon_url: input.iconUrl },
        postedMessage,
      );
    } catch (err) {
      if (!(err instanceof SlackApiError) || err.code !== "missing_scope") {
        throw err;
      }
      iconlessBotTokens.set(botToken, Date.now());
    }
  }
  return slackCall("chat.postMessage", botToken, form, postedMessage);
};

export const updateBlocks = (
  botToken: string,
  input: { channel: string; ts: string; text: string; blocks?: unknown[] },
) =>
  slackCall(
    "chat.update",
    botToken,
    {
      channel: input.channel,
      ts: input.ts,
      text: input.text,
      ...(input.blocks && { blocks: JSON.stringify(input.blocks) }),
    },
    z.object({ ts: z.string().min(1) }),
  );

// Slack's streaming trio (chat.startStream/appendStream/stopStream) is
// deliberately absent: answers post ONCE on completion (the live-edit
// rendering design was removed — the step-6 plan doc records the decision).
