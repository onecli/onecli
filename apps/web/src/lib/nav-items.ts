import { LayoutDashboard, Bot, KeyRound, Settings } from "lucide-react";
import type { NavItem } from "@/app/(dashboard)/_components/nav-main";

export const navItems: NavItem[] = [
  { title: "Overview", url: "/overview", icon: LayoutDashboard },
  { title: "Agents", url: "/agents", icon: Bot },
  { title: "Secrets", url: "/secrets", icon: KeyRound },
  { title: "Settings", url: "/settings", icon: Settings },
];
