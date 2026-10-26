/**
 * A transcript's geometry, in one place: the classes below and the pixel
 * values the send pin computes with must change together
 * (`transcript-layout.test.ts` holds them to each other).
 */

/**
 * Vertical padding of a transcript inside `FollowingViewport`: `pt-6` (24px)
 * on top, and `pb-10` at the bottom so the newest item clears the viewport's
 * 2rem bottom fade (`scroll-fade-b`) instead of reading as cut off.
 */
export const TRANSCRIPT_PADDING = "pt-6 pb-10";

/**
 * Where a pinned send lands: 64px from the top, so a sliver of the previous
 * reply stays in view. The scroller adds the content's top padding (`pt-6`,
 * 24px) to the margin when it aligns a row to the start, so the margin is
 * the peek net of that padding.
 */
export const PIN_SCROLL_MARGIN_PX = 64 - 24;

/**
 * The row under a pinned send is at least one viewport tall, minus the peek
 * above it (64px) and the bottom padding (`pb-10`), so the sent message can
 * sit at the top while the reply is still short. `cqh` reads the viewport's
 * height (it is a size container), so this is pure CSS and nothing is
 * measured while the reply streams.
 */
export const PINNED_ROW = "min-h-[calc(100cqh-64px-2.5rem)]";
