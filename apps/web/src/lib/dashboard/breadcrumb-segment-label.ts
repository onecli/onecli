import { getApp } from "@onecli/api/apps/registry";

/**
 * The words the connections tabs render. A crumb over a tab must say what the
 * tab says ("LLMs", not the title-cased slug "Llms").
 */
const CONNECTIONS_SEGMENT_TITLES: Record<string, string> = {
  apps: "Apps",
  custom: "Custom",
  llms: "LLMs",
  vaults: "Vaults",
  connected: "Connected",
};

const titleCase = (segment: string): string =>
  segment.charAt(0).toUpperCase() + segment.slice(1).replace(/-/g, " ");

/**
 * The header breadcrumb's label for a URL segment below a section. Inside a
 * connections section (the workspace's or the org's Global Connections) a
 * segment is either a tab or an app/vault id, and both have a real name: the
 * tab's own word, or the app's display name ("GitHub", never "Github").
 * Anything else falls back to title-casing the slug.
 */
export const breadcrumbSegmentLabel = (
  segment: string,
  opts: { inConnections: boolean },
): string => {
  if (opts.inConnections) {
    const tab = CONNECTIONS_SEGMENT_TITLES[segment];
    if (tab) return tab;
    const app = getApp(segment);
    if (app) return app.name;
  }
  return titleCase(segment);
};
