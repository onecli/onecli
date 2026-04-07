import { User, KeyRound, ShieldCheck, Settings } from "lucide-react";

export interface SettingsNavItem {
  title: string;
  url: string;
  icon: React.ComponentType<{ className?: string }>;
}

export interface SettingsNavSection {
  label: string;
  items: SettingsNavItem[];
}

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
  {
    label: "Instance",
    items: [{ title: "General", url: "/settings/general", icon: Settings }],
  },
];
