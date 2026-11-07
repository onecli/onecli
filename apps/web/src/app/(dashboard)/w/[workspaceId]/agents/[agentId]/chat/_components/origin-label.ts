/** Named doors get a proper label; an unrecognized one still says where it
 *  came from rather than nothing. "web" is home, so no chip. */
const ORIGIN_LABELS: Record<string, string> = {
  slack: "via Slack",
  // A peer agent's words on the pair conversation (PR 5b); the bubble's
  // text already names which agent, in its `Name (agent):` frame.
  agent: "from another agent",
};

/** The quiet provenance chip for a message that entered through another
 *  door ("via Slack"); none for the web, the chat's own home. */
export const originLabel = (source: string): string | undefined =>
  source === "web" ? undefined : (ORIGIN_LABELS[source] ?? `via ${source}`);
