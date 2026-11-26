/**
 * The dashboard frame's boxes, in one place: the shell draws them, and so
 * does the skeleton shown while the shell waits (sign-in, the session check,
 * the first agent read). Sharing the classes is what keeps the skeleton
 * where the page will be, so nothing moves when the real chrome replaces it.
 */

/** The whole viewport: cream canvas, rail, sidebar, page panel. */
export const SHELL_FRAME = "bg-canvas flex h-svh w-full overflow-hidden";

/** The theater's frame (the agent's full-page desktop): no chrome at all. */
export const THEATER_FRAME =
  "dark flex h-svh min-w-0 flex-col overflow-hidden bg-black text-white";

/** The 60px rail: logo, agents, New agent, gear, account. */
export const SHELL_RAIL =
  "flex w-15 shrink-0 flex-col items-center gap-2 border-r py-3";

/** The rail's agent list. Scrolls once the agents outgrow the rail; the
 *  edges fade so a cut-off list reads as "more below", even where the OS
 *  hides scrollbars, and the padding keeps a short list clear of the fade. */
export const SHELL_RAIL_LIST =
  "-my-1.5 flex min-h-0 w-full shrink flex-col items-center gap-2 overflow-y-auto overscroll-contain px-1 py-3 [scrollbar-width:none] [mask-image:linear-gradient(to_bottom,transparent,black_12px,black_calc(100%-12px),transparent)] [&::-webkit-scrollbar]:hidden";

/** The rail square's frame: every entry, and the New agent menu trigger. */
export const RAIL_BUTTON =
  "focus-visible:ring-ring flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors outline-none focus-visible:ring-2";

/** A rail entry at rest: muted, lifting to the foreground on hover. */
export const RAIL_BUTTON_IDLE =
  "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground";

/** An agent's round square in the rail at rest. The square's own hover wash
 *  shows only as a thin rim around the avatar, so agents take it a shade
 *  darker, fading in and out over 200ms. */
export const RAIL_AGENT_IDLE =
  "hover:bg-foreground/[0.12] focus-visible:bg-foreground/[0.12] duration-200 ease-out";

/** The sidebar column beside the rail. */
export const SHELL_SIDEBAR =
  "flex w-58 shrink-0 flex-col overflow-y-auto px-3 py-3";

/** The page sits on a bordered panel over the canvas, so the rail and
 *  sidebar read as the frame around it. */
export const SHELL_PANEL =
  "bg-background flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:my-2 md:mr-2 md:rounded-lg md:border";

/** The panel's top bar. */
export const SHELL_TOP_BAR =
  "flex h-12 shrink-0 items-center gap-2 border-b px-4";

/** The panel's body: the cell a page fills. */
export const SHELL_BODY = "flex min-h-0 min-w-0 flex-1 overflow-hidden";

/** A non-agent page's scroll area, and the width-bounded column in it. */
export const SHELL_PAGE_SCROLL =
  "min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden";
export const SHELL_PAGE = "mx-auto min-w-0 max-w-6xl p-4 sm:p-6";

/**
 * The sidebar's agent header, on the same line as the page's top bar: that
 * bar is h-12 (48px) inside a panel with an 8px top margin and a 1px border
 * on wide screens, so this box is 57px there (48px on a phone, where the
 * panel has neither). The line stops inside the sidebar's padding instead
 * of running into the page, so the two read as level but separate.
 */
export const SIDEBAR_AGENT_HEADER =
  "-mt-3 mb-3 flex h-12 shrink-0 items-center gap-2 border-b px-1 md:h-[57px] md:pt-[9px]";

/** One sidebar row: 32px (a 20px line and py-1.5). */
export const SIDEBAR_ROW =
  "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm";

/** The label over the sidebar's bottom block ("Organization"). Full
 *  muted-foreground: at 11px it needs 4.5:1 on the canvas, and the /80
 *  tint it had measured 3.5:1 in the light theme. */
export const SIDEBAR_SCOPE_LABEL =
  "text-muted-foreground px-2 pb-1 text-[11px] font-medium tracking-wide uppercase";

/**
 * The sidebar's bottom block, its top line level with the chat composer's:
 * the composer is 63px (its 1px top border, then p-3 around a 38px input:
 * 20px of text, py-2, a 1px border each side) inside a panel with an 8px
 * bottom margin and a 1px border on wide screens, so the box under the line
 * is 72px there. The label rides above the line, and the line stops inside
 * the sidebar's padding, like the one at the top.
 */
export const SIDEBAR_SCOPE_BOX =
  "-mb-3 flex flex-col justify-center border-t py-2 md:h-[72px] md:py-0 md:pb-[9px]";
