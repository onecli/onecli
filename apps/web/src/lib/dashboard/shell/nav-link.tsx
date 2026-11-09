"use client";

import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { cn } from "@onecli/ui/lib/utils";
import { NavLinkLabel } from "./nav-link-label";
import { SIDEBAR_ROW } from "./shell-geometry";
import { useNavIconLoop } from "./use-nav-icon-loop";

/** One sidebar row: the page it opens, highlighted while it is the page on
 *  screen. `prominent` is the agent's home row (Chat), set in bold. Hovering
 *  the row plays its icon's loop, if the icon has one. */
export const NavLink = ({
  href,
  active,
  icon,
  title,
  prominent,
}: {
  href: string;
  active: boolean;
  icon: LucideIcon;
  title: string;
  prominent?: boolean;
}) => {
  const hover = useNavIconLoop(icon);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      {...hover?.rowProps}
      className={cn(
        SIDEBAR_ROW,
        "focus-visible:ring-ring transition-colors outline-none focus-visible:ring-2",
        active
          ? cn(
              "bg-brand-wash text-brand-ink",
              prominent ? "font-semibold" : "font-medium",
            )
          : cn(
              "text-foreground/80 hover:bg-foreground/[0.05] hover:text-foreground",
              prominent && "font-semibold",
            ),
      )}
    >
      <NavLinkLabel
        icon={icon}
        title={title}
        loop={hover?.loop}
        iconRef={hover?.svgRef}
      />
    </Link>
  );
};
