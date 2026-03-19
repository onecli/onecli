import { LayoutDashboard, Bot, KeyRound, Shield, Settings } from "lucide-react";
import type { NavItem } from "@/app/(dashboard)/_components/nav-main";

export const navItems: NavItem[] = [
  { title: "Overview", url: "/overview", icon: LayoutDashboard },
  { title: "Agents", url: "/agents", icon: Bot },
  { title: "Secrets", url: "/secrets", icon: KeyRound },
  { title: "Rules", url: "/rules", icon: Shield },
  { title: "Settings", url: "/settings", icon: Settings },
];
