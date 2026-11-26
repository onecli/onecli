"use client";

import { useLinkStatus } from "next/link";
import type { RefObject } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@onecli/ui/lib/utils";
import type { IconLoop } from "./nav-icon-loop";
import { NavIconExtras } from "./nav-icon-extras";

/**
 * A nav row's icon and title. Rendered INSIDE the row's `<Link>`, where
 * `useLinkStatus` reports that this link's navigation is in flight: the
 * icon dims on the click, so a slow server render never reads as a missed
 * click. The row's highlight still follows the page once it lands. With a
 * hover loop, the icon carries the loop's extra strokes (hidden at rest)
 * and the ref the loop plays on.
 */
export const NavLinkLabel = ({
  icon: Icon,
  title,
  loop,
  iconRef,
}: {
  icon: LucideIcon;
  title: string;
  loop?: IconLoop;
  iconRef?: RefObject<SVGSVGElement | null>;
}) => {
  const { pending } = useLinkStatus();
  return (
    <>
      <Icon
        ref={iconRef}
        className={cn(
          "size-4 shrink-0 overflow-visible transition-opacity",
          pending && "opacity-60",
        )}
        aria-hidden
      >
        {loop && <NavIconExtras loop={loop} />}
      </Icon>
      <span className="truncate">{title}</span>
    </>
  );
};
