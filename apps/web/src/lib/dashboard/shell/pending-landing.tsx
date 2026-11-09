import { AgentNavSkeleton } from "./agent-nav-skeleton";
import { DashboardShellSkeleton } from "./dashboard-shell-skeleton";

/**
 * The dashboard while a visitor's landing is still being worked out (the
 * home page, a sign-in that just succeeded, or an old address on its way to
 * its new page): the agent's sidebar, where nearly everyone lands, over an
 * empty panel. The section is not known yet, and a guessed body would be
 * swapped for another, so the landing's own skeleton fills the panel.
 *
 * `children` sits in that panel: an old address's page renders nothing
 * while it forwards, and if it fails instead, its error shows where the
 * page would have been.
 */
export const PendingLanding = ({
  children = null,
}: {
  children?: React.ReactNode;
}) => <DashboardShellSkeleton sidebar={<AgentNavSkeleton />} body={children} />;
