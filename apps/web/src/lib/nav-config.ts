import {
  LayoutDashboard,
  Bot,
  Shield,
  Settings,
  Plug,
  Activity,
  User,
  KeyRound,
  ShieldCheck,
  Globe,
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
  { title: "Activity", url: "/activity", icon: Activity },
  { title: "Settings", url: "/settings", icon: Settings },
];

export const getSettingsSections = (
  // Cloud override uses orgId to prefix URLs with /org/<id>
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  orgId?: string,
): SettingsNavSection[] => [
  {
    label: "General",
    items: [{ title: "Instance", url: "/settings/instance", icon: Globe }],
  },
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
      { title: "Policy", url: "/settings/policy", icon: Shield },
      { title: "Encryption", url: "/settings/encryption", icon: ShieldCheck },
    ],
  },
];

export const settingsSections = getSettingsSections();
