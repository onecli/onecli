import {
  LayoutDashboard,
  Bot,
  Shield,
  Settings,
  Plug,
  User,
  KeyRound,
  ShieldCheck,
} from "lucide-react";
import type { NavItem } from "@/app/(dashboard)/_components/nav-main";

export interface SettingsNavItem {
  title: string;
  url: string;
  icon: React.ComponentType<{ className?: string }>;
}

export interface SettingsNavSection {
  label: string;
  items: SettingsNavItem[];
}

export const navItems: NavItem[] = [
  { title: "Overview", url: "/overview", icon: LayoutDashboard },
  { title: "Agents", url: "/agents", icon: Bot },
  { title: "Rules", url: "/rules", icon: Shield },
  { title: "Connections", url: "/connections", icon: Plug },
  { title: "Settings", url: "/settings", icon: Settings },
];

export const settingsSections: SettingsNavSection[] = [
  {
    label: "Account",
    items: [
      { title: "Profile", url: "/settings/profile", icon: User },
      { title: "API Keys", url: "/settings/api-keys", icon: KeyRound },
    ],
  },
  {
    label: "Security",
    items: [
      { title: "Encryption", url: "/settings/encryption", icon: ShieldCheck },
    ],
  },
];
