import type { IconLoop } from "./nav-icon-loop";

/**
 * A hover loop's extra strokes (typing dots, the plug's cord, bubbles),
 * drawn inside the Lucide icon after its own nodes, so the loop
 * finds them by index. Hidden at rest: the icon looks exactly as Lucide
 * draws it until a loop shows them.
 */
export const NavIconExtras = ({ loop }: { loop: IconLoop }) =>
  loop.extras?.map(([Tag, attrs], i) => (
    // Fixed per icon and never reordered: the index is the identity.
    <Tag key={i} {...attrs} />
  ));
