import {
  LayoutDashboard,
  ScrollText,
  Bot,
  KeyRound,
  ShieldCheck,
  Settings,
} from "lucide-react";
import type { NavItem } from "@/app/(dashboard)/_components/nav-main";

export const navItems: NavItem[] = [
  { title: "Overview", url: "/overview", icon: LayoutDashboard },
  { title: "Agents", url: "/agents", icon: Bot },
  { title: "Secrets", url: "/secrets", icon: KeyRound },
  { title: "Policies", url: "/policies", icon: ShieldCheck },
  { title: "Audit Log", url: "/audit", icon: ScrollText },
  { title: "Settings", url: "/settings", icon: Settings },
];
