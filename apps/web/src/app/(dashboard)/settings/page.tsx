import { redirect } from "next/navigation";
import { settingsSections } from "@/lib/nav-config";

export default function SettingsPage() {
  const firstItem = settingsSections[0]?.items[0];
  redirect(firstItem?.url ?? "/settings/profile");
}
