/**
 * THE CONTEXT-FIT RULE: which context size a conversation should run at,
 * from its own recent turns. Pure (no I/O, no clock of its own) so every
 * band, the cooldown and the evidence boundary are unit-testable; the
 * platform job (`context-fit-service.ts`) reads the rows and applies the
 * answer.
 *
 * The signal is how full each turn's context was: the prompt the turn's
 * LATEST model call carried (`promptTokens` on its usage, which the harness
 * normalizes for its provider's cache accounting), not a running total.
 *
 * The rule moves one rung at a time and only on sustained evidence:
 *
 * - GROW when most recent turns press against the current size. The bar
 *   sits BELOW the harness's own summarizing point: jcode starts
 *   summarizing the conversation at 80% of its budget (pinned runtime), and
 *   a slowly growing thread is cut back to about a fifth of the budget the
 *   turn it crosses that line, so a bar at 80% would almost never see three
 *   turns above it. Measured live on a real model at 200k: the prompts
 *   climbed ~7k per turn to 165k and 172k, then fell to 78k. At 70% the
 *   same thread grows three turns BEFORE the cut, keeping the detail.
 * - SHRINK when a long run of turns all sat far below even the next smaller
 *   size (a smaller size costs nothing such a conversation uses, and keeps
 *   each request small).
 * - Only turns AFTER the last change count, so a conversation never moves
 *   again on evidence gathered at its previous size, and a cooldown spaces
 *   changes out so a size never flips back and forth.
 *
 * What the model and the credential allow is NOT decided here: the harness
 * clamps the size to the model's own window, and the dispatch clamps it to
 * the platform's limit (trial credit). This rule only says what the
 * conversation would use.
 */

/** The ladder, smallest first. The DB CHECK holds `context_tokens` to it. */
const CONTEXT_SIZES = [100_000, 200_000, 1_000_000] as const;
export type ContextSize = (typeof CONTEXT_SIZES)[number];

/** A conversation with no size yet runs at this one: today's default. */
const DEFAULT_CONTEXT_SIZE: ContextSize = 200_000;

/** Grow when at least GROW_MIN_HITS of the last GROW_WINDOW turns used more
 * than GROW_FILL of the current size: under the harness's 80% summarizing
 * point (see the module doc), so the decision lands before detail is cut. */
const GROW_WINDOW = 5;
const GROW_MIN_HITS = 3;
const GROW_FILL = 0.7;

/** Shrink when the last SHRINK_WINDOW turns ALL used less than SHRINK_FILL
 * of the next smaller size. */
const SHRINK_WINDOW = 10;
const SHRINK_FILL = 0.5;

/** The least time between two changes of one conversation's size. */
export const CONTEXT_FIT_COOLDOWN_MS = 30 * 60 * 1000;

/** The most recent turns the rule ever looks at. */
export const CONTEXT_FIT_LOOKBACK = Math.max(GROW_WINDOW, SHRINK_WINDOW);

export interface ContextFitInput {
  /** The conversation's stored size; null = the default. */
  current: ContextSize | null;
  /** When it last changed; null = never. */
  changedAt: Date | null;
  /**
   * Context tokens of the conversation's finished turns SINCE the last
   * change, newest first. Turns without usage are left out by the caller.
   */
  recentFill: readonly number[];
  now: Date;
}

const rungOf = (size: ContextSize): number => CONTEXT_SIZES.indexOf(size);

/**
 * The size this conversation should move to, or null to stay. Never more
 * than one rung from where it is.
 */
export const decideContextSize = ({
  current,
  changedAt,
  recentFill,
  now,
}: ContextFitInput): ContextSize | null => {
  if (
    changedAt &&
    now.getTime() - changedAt.getTime() < CONTEXT_FIT_COOLDOWN_MS
  ) {
    return null;
  }
  const size = current ?? DEFAULT_CONTEXT_SIZE;
  const rung = rungOf(size);

  const larger = CONTEXT_SIZES[rung + 1];
  if (larger !== undefined && recentFill.length >= GROW_WINDOW) {
    const hits = recentFill
      .slice(0, GROW_WINDOW)
      .filter((fill) => fill > size * GROW_FILL).length;
    if (hits >= GROW_MIN_HITS) return larger;
  }

  const smaller = CONTEXT_SIZES[rung - 1];
  if (smaller !== undefined && recentFill.length >= SHRINK_WINDOW) {
    const allSmall = recentFill
      .slice(0, SHRINK_WINDOW)
      .every((fill) => fill < smaller * SHRINK_FILL);
    if (allSmall) return smaller;
  }

  return null;
};

/** Narrow a stored number to a ladder size (the CHECK makes anything else
 * impossible; this keeps the type honest without an assertion). */
export const asContextSize = (value: number | null): ContextSize | null =>
  CONTEXT_SIZES.find((size) => size === value) ?? null;
