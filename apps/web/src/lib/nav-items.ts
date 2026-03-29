import { LayoutDashboard, Bot, Shield, Settings, Plug } from "lucide-react";
import type { NavItem } from "@/app/(dashboard)/_components/nav-main";

export const navItems: NavItem[] = [
  { title: "Overview", url: "/overview", icon: LayoutDashboard },
  { title: "Agents", url: "/agents", icon: Bot },
  { title: "Rules", url: "/rules", icon: Shield },
  { title: "Connections", url: "/connections", icon: Plug },
  { title: "Settings", url: "/settings", icon: Settings },
];
