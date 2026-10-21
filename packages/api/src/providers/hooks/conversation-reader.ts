import { createEditionSlot } from "../edition-state";

/**
 * The `read_conversation` platform tool's body: reading conversations a
 * person granted through "Connect your Slack" (licensed: granular_access).
 * The shared tool dispatcher calls this seam; the implementation lives in
 * `ee/slack-read` and is injected at server boot when entitled. Absent
 * (unlicensed self-host) = the tool refuses with the license message, and
 * the supervisor never lists it.
 */
export interface ConversationReader {
  read(input: {
    agentId: string;
    /** The verified reader: a direct thread's owner or a schedule's
     * creator; null for any shared conversation. */
    readerUserId: string | null;
    /** Omitted = list what this reader may read. */
    conversation?: string;
    sinceHours?: number;
    threadRef?: string;
    /** Page back: only messages older than this message id. */
    before?: string;
    limit?: number;
  }): Promise<{ ok: true; result: unknown } | { ok: false; error: string }>;
}

const slot = createEditionSlot<ConversationReader | null>(
  "conversationReader",
  null,
);

/** Test seam (`null` resets to the edition default). */
export const initConversationReader = (r: ConversationReader | null) =>
  slot.init(r);

/** Package-internal: the edition-defaults injector. */
export const setDefaultConversationReader = (r: ConversationReader) =>
  slot.setCloudDefault(r);

export const getConversationReader = (): ConversationReader | null =>
  slot.get();

/**
 * The "Connect your Slack" OAuth return: the shared Slack callback route
 * hands a verified-kind state here. Same licensing as the reader (null =
 * unlicensed: the callback refuses).
 */
export interface UserReadConnectCompleter {
  /** Routing peek on the UNVERIFIED state kind. */
  handles(kind: string | null): boolean;
  complete(input: {
    state: string;
    code: string;
    redirectUri: string;
  }): Promise<{ workspaceId: string; agentId: string }>;
}

const completerSlot = createEditionSlot<UserReadConnectCompleter | null>(
  "userReadConnectCompleter",
  null,
);

export const initUserReadConnectCompleter = (
  c: UserReadConnectCompleter | null,
) => completerSlot.init(c);

export const setDefaultUserReadConnectCompleter = (
  c: UserReadConnectCompleter,
) => completerSlot.setCloudDefault(c);

export const getUserReadConnectCompleter =
  (): UserReadConnectCompleter | null => completerSlot.get();
