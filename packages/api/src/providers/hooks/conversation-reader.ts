import { createEditionSlot } from "../edition-state";

/**
 * One act-as-you tool call's answer: a result object for the model, or a
 * refusal it reads verbatim. Shared by the reader and the sender.
 */
export type ActAsYouOutcome =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * The `read_conversation` platform tool's body: reading conversations a
 * person granted through "Connect your Slack" (licensed: granular_access).
 * The shared tool dispatcher calls this seam; the implementation lives in
 * `ee/slack-read` and is injected at server boot when entitled. Absent
 * (unlicensed self-host) = the tool refuses with the license message.
 */
export interface ConversationReader {
  read(input: {
    agentId: string;
    /** The verified reader: a direct thread's owner or a schedule's
     * creator; null for any shared conversation. */
    readerUserId: string | null;
    /** Who typed this turn (may differ from the reader: null reader in a
     * shared place). Only names them in the private-chat refusal. */
    askerUserId?: string | null;
    /** Omitted = list what this reader may read. */
    conversation?: string;
    sinceHours?: number;
    threadRef?: string;
    /** Page back: only messages older than this message id. */
    before?: string;
    limit?: number;
    /** The verified calling conversation/turn: where an "ask" read's
     * approval outcome lands. Null = no anchor (dashboard-only). */
    originConversationId?: string | null;
    originTurnId?: string | null;
  }): Promise<ActAsYouOutcome>;
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
 * The `send_as_me` platform tool's body: posting AS the person who connected
 * their Slack, into a conversation they set to send allow/ask. Same
 * licensing and injection as the reader (null = unlicensed: the tool
 * refuses).
 */
export interface ConversationSender {
  /** Whether sending as a person is possible for this agent at all: the
   * org is licensed for it and the agent has a live Slack presence. Says
   * nothing about any one person's connection (send_message "ask" offers
   * the choice even before they connect). Never throws. */
  available(agentId: string): Promise<boolean>;
  send(input: {
    agentId: string;
    /** The verified reader (see ConversationReader); only their own grants
     * are targetable, and null refuses. */
    readerUserId: string | null;
    askerUserId?: string | null;
    /** The conversation's name, as the model gave it. */
    conversation: string;
    /** Its exact provider id when the platform already resolved it (a
     * send_message recipient: the channel, or the person a DM is with):
     * targets that conversation and nothing else. Absent = an exact name. */
    conversationRef?: string;
    text: string;
    originConversationId: string | null;
    originTurnId: string | null;
    /** The reader picked "Send as me" for THIS exact message (a
     * choose-sender card): that pick is their consent, so the conversation
     * is shared with writing allowed (persisted) instead of raising a
     * share / allow-writing card. Connect and reconnect still ask. */
    consented?: boolean;
  }): Promise<ActAsYouOutcome>;
  /** `edit_my_message`: rewrite a message this agent sent AS the reader
   * (send_as_me) in the last 24h. Same fence and write mode as send. */
  edit(input: OwnMessageInput & { text: string }): Promise<ActAsYouOutcome>;
  /** `delete_my_message`: same fence; always held for the reader. */
  delete(input: OwnMessageInput): Promise<ActAsYouOutcome>;
}

export interface OwnMessageInput {
  agentId: string;
  readerUserId: string | null;
  askerUserId?: string | null;
  conversation: string;
  /** The messageId a send_as_me result returned. */
  messageId: string;
  originConversationId: string | null;
  originTurnId: string | null;
}

const senderSlot = createEditionSlot<ConversationSender | null>(
  "conversationSender",
  null,
);

export const initConversationSender = (s: ConversationSender | null) =>
  senderSlot.init(s);

export const setDefaultConversationSender = (s: ConversationSender) =>
  senderSlot.setCloudDefault(s);

export const getConversationSender = (): ConversationSender | null =>
  senderSlot.get();

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
