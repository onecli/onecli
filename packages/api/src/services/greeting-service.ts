import { db } from "@onecli/db";
import { randomUUID } from "node:crypto";
import { stripControl } from "../lib/text";
import { signalWork } from "./due-work";
import { wakeSandboxFor } from "./turn-service";
import { findAgentLlmBlocker } from "./llm-credential-service";
import { isOnboardingCreatedAgent } from "./onboarding-service";
import { GREETING_SOURCE } from "../validations/conversation";
import { logger } from "../lib/logger";

const log = logger.child({ component: "greeting-service" });

/**
 * THE AGENT SPEAKS FIRST — ONCE, AT ONBOARDING.
 *
 * The first time a person opens the direct thread with the agent THEY CREATED
 * DURING ONBOARDING, the thread is empty and nothing has been said. Rather
 * than the web hanging a pre-written sign in the agent's bubble, the platform
 * posts one instruction turn (source `greeting`, no user) and the agent
 * ANSWERS IT LIVE, exactly the way it answers everything else: sandbox,
 * model, streamed text. The chat hides the instruction (platform-authored
 * rows never wear a user bubble) and the person watches their agent write to
 * them.
 *
 * Three fences make this safe to call from the thread-open door on every load:
 *
 *   1. **Only the ONBOARDING agent is greeted**, and only for the person who
 *      onboarded (`isOnboardingCreatedAgent`). This is a first-run moment, not
 *      a property of opening a thread: every agent a person creates later from
 *      the dashboard opens its thread through this same door, and greeting
 *      those turned a one-time welcome into an unsolicited message from every
 *      new agent. A greeting nobody asked for is not a nicety.
 *
 *   2. **Only a thread with NO turns is greeted**, and the check and the
 *      insert are ONE statement (see `claimGreeting`). The thread-open door
 *      is a PUT that React Query may re-run — a StrictMode double-invoke, a
 *      refetch, a second tab — so the race is ordinary, not exotic.
 *
 *      The one-active-turn index would in fact catch the live greeting on its
 *      own (it is born `queued`, and the index admits exactly one active row
 *      per conversation — measured). The claim is still written as a single
 *      `INSERT … WHERE NOT EXISTS` because that fence belongs to the GREETING
 *      rather than to the status it happens to be born in: the PR this
 *      replaced also posted greetings born `done`, which the index's
 *      ACTIVE-only predicate does not cover at all (5 of 5 parallel inserts
 *      landed). One statement, one greeting, whatever the status.
 *
 *   3. **No model key → no greeting at all.** A greeting exists to be
 *      answered; an agent that cannot run cannot answer one, and a turn that
 *      fails coded `no_model_key` would put a failure card at the very top of
 *      a brand-new thread. The web renders its own empty-thread welcome in
 *      that case — in the PRODUCT's voice, not the agent's, because words the
 *      agent never said must never appear in its bubble. For the same reason
 *      the greeting itself is a BRIEF, never a script to recite: what lands
 *      in the agent's bubble is always the agent's own writing.
 */

/** How much of a person's display name may reach the model instruction. */
const FIRST_NAME_MAX_CHARS = 40;

/** How much of a person's email may reach the model instruction (RFC 5321
 * caps an address at 254). */
const EMAIL_MAX_CHARS = 254;

/** What the agent is asked to do: write its own first message, in its own
 * voice, to the brief below. A brief, never a script: the welcome must be
 * the agent's words (the product's no-ventriloquism rule, header point 3),
 * so it reads like every other reply it gives. The web renders the Gmail
 * card and an "Add different tools" button under the reply, so the brief
 * points at Gmail and asks for no links or other apps. */
export const buildGreetingInstruction = ({
  email,
  agentName,
}: {
  email: string | null;
  agentName: string;
}): string =>
  [
    "This is the very first message in a brand-new conversation with a person who just signed up" +
      (email ? ` (their email is ${email})` : "") +
      ".",
    `Write your welcome in your own words, as ${agentName}, in three or four short sentences:`,
    "greet them, say who you are and that you can get work done for them even while they are away,",
    "ask what their name is, and suggest they start by connecting their Gmail with the button below your message.",
    "Do not list capabilities, do not use headings, bullet points or links, do not name other apps, and do not use tools.",
  ].join(" ");

/**
 * An email address bounded and cleaned for a model instruction: control
 * characters stripped, whitespace removed, length capped. The email is the
 * account's own (set at sign-up, verified by the auth provider), and it only
 * ever reaches that person's own agent; the bound is hygiene, not a trust
 * boundary.
 */
export const emailForGreeting = (
  email: string | null | undefined,
): string | null => {
  const clean = stripControl(email ?? "").replace(/\s+/g, "");
  if (!clean || !clean.includes("@")) return null;
  return clean.length > EMAIL_MAX_CHARS ? null : clean;
};

/**
 * A name, first word only, BOUNDED, because it is a user-controlled string
 * (a display name or an agent name, 1..255 chars of anything) on its way
 * into a model instruction. Control characters are stripped and the word is
 * capped: the same treatment every other user-supplied string gets before it
 * reaches the model (see `stripControl` in turn-service's bridge). A person
 * can still only steer their OWN agent this way, so the bound is hygiene
 * rather than a trust boundary.
 */
export const firstNameOf = (name: string | null | undefined): string | null => {
  const first = stripControl(name ?? "")
    .trim()
    .split(/\s+/)[0];
  if (!first) return null;
  return first.length > FIRST_NAME_MAX_CHARS
    ? first.slice(0, FIRST_NAME_MAX_CHARS)
    : first;
};

/**
 * Claim the right to greet, atomically: insert the greeting turn only if this
 * conversation has no turns at all. `INSERT … SELECT … WHERE NOT EXISTS` is
 * the whole fence — under concurrency exactly one statement inserts a row and
 * the others affect zero, with no application-level check-then-act window and
 * no reliance on the one-active-turn index.
 *
 * Returns the claimed turn id, or null when someone else already spoke.
 */
const claimGreeting = async (
  conversationId: string,
  message: string,
): Promise<string | null> => {
  // The id is generated here rather than by the database: `Turn.id` is a
  // Prisma-side `@default(uuid())`, so the column has no DB default to lean
  // on in raw SQL.
  const id = randomUUID();
  const inserted = await db.$executeRaw`
    INSERT INTO "turns" ("id", "conversation_id", "message", "status", "source", "user_id", "created_at", "updated_at")
    SELECT ${id}, ${conversationId}, ${message}, 'queued', ${GREETING_SOURCE}, NULL, now(), now()
    WHERE NOT EXISTS (
      SELECT 1 FROM "turns" WHERE "conversation_id" = ${conversationId}
    )
  `;
  return inserted > 0 ? id : null;
};

/**
 * Greet the onboarding agent's direct thread, when it has never had a turn.
 * Idempotent and best-effort: it never throws into the thread-open door,
 * because a greeting that failed to post is a missed nicety, not a broken
 * chat.
 */
export const greetEmptyDirectThread = async (
  workspaceId: string,
  conversation: { id: string; agentId: string; direct: boolean },
  userId: string,
): Promise<void> => {
  // The greeting is a DIRECT-thread nicety. `createTurn`'s wake door would
  // refuse a group conversation anyway, but the raw claim below runs first —
  // so the fence is stated here rather than inferred two calls later.
  if (!conversation.direct) return;

  try {
    // Cheap pre-check: every visit after the first takes this arm and pays
    // one indexed count instead of an insert attempt.
    const existing = await db.turn.count({
      where: { conversationId: conversation.id },
    });
    if (existing > 0) return;

    // ONBOARDING ONLY — the fence that makes this a first-run moment rather
    // than something every new agent does. Ahead of the credential check
    // because it is one indexed read and it rejects the common case: on a
    // workspace that has been used at all, most agents are not the
    // onboarding one.
    const onboarding = await isOnboardingCreatedAgent(
      workspaceId,
      conversation.agentId,
      userId,
    );
    if (!onboarding) return;

    // An agent that cannot run cannot answer a greeting. Say nothing rather
    // than open the product with a failure card — the web's empty-thread
    // welcome covers this case in the product's own voice.
    const blocker = await findAgentLlmBlocker(
      workspaceId,
      conversation.agentId,
    );
    if (blocker) return;

    const [user, agent] = await Promise.all([
      db.user.findUnique({
        where: { id: userId },
        select: { email: true },
      }),
      db.agent.findFirst({
        where: { id: conversation.agentId, workspaceId },
        select: { name: true },
      }),
    ]);

    const turnId = await claimGreeting(
      conversation.id,
      buildGreetingInstruction({
        email: emailForGreeting(user?.email),
        agentName: firstNameOf(agent?.name) ?? "your assistant",
      }),
    );
    // Lost the race — another open is already greeting this thread.
    if (!turnId) return;

    // The row is committed and `queued`; now do what `createTurn` does after
    // its own insert, so the greeting dispatches instead of waiting for the
    // next poll: wake a parked sandbox and signal the held runner poll.
    await wakeSandboxFor(conversation.agentId);
    signalWork();
  } catch (err) {
    log.info(
      { err: String(err), conversationId: conversation.id },
      "greeting not posted",
    );
  }
};
