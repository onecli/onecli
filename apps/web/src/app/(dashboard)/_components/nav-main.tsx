import type { LucideIcon } from "lucide-react";

/** One row of a scope's nav (`lib/nav-config`): the sidebar renders it. */
export interface NavItem {
  title: string;
  url: string;
  icon: LucideIcon;
}
