/**
 * The inline-link idiom for helper text: foreground + underline at rest, a
 * thicker underline on hover, a ring on keyboard focus. Shared by real anchors
 * and by link-styled buttons (CopyableCommand's `link` variant) so a command
 * offered as a link's peer reads as one in every state, not just at rest.
 */
export const inlineLinkClassName =
  "text-foreground focus-visible:ring-ring rounded-sm underline underline-offset-2 hover:decoration-2 focus-visible:ring-2 focus-visible:outline-none";
