import type { CharacterProps } from "@/lib/components/character";
import type { SettingsPageId } from "./pages";

/**
 * The character on each Settings modal page's banner, picked to match what
 * the page is about. One pose per page, so no two pages in the modal share
 * one.
 */
export const SETTINGS_PAGE_POSES: Record<
  SettingsPageId,
  CharacterProps["name"]
> = {
  members: "drop-cheer",
  apps: "cloud-key",
  activity: "drop-think",
  workspace: "drop-list",
  general: "cloud-list",
  "shared-apps": "cloud-think",
  rules: "cloud-wait",
  slack: "drop-mug",
  workspaces: "cloud",
  security: "drop",
  billing: "drop-book",
  profile: "cloud-mug",
  "api-keys": "drop-key",
};
