import { User, KeyRound, ScrollText } from "lucide-react";
import type { NavItem } from "@dashboard/nav-main";

export interface AccountNavItem {
  title: string;
  url: string;
  icon: React.ComponentType<{ className?: string }>;
}

export interface AccountNavSection {
  label: string;
  items: AccountNavItem[];
}

export const accountNavSections: AccountNavSection[] = [
  {
    label: "Account Settings",
    items: [
      { title: "Preferences", url: "/account/preferences", icon: User },
      { title: "SSH Keys", url: "/account/ssh-keys", icon: KeyRound },
    ],
  },
  {
    label: "Logs",
    items: [
      { title: "Audit Logs", url: "/account/audit-logs", icon: ScrollText },
    ],
  },
];

export const accountNavItems: NavItem[] = accountNavSections.flatMap((s) =>
  s.items.map((item) => ({
    title: item.title,
    url: item.url,
    icon: item.icon as NavItem["icon"],
  })),
);
