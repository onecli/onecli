import { unstable_isUnrecognizedActionError } from "next/navigation";
import { toast } from "sonner";

/** One notice per tab, however many reads and writes fail at once: a window
 * refocus refetches every mounted query, and each one would otherwise stack
 * its own copy. A fixed id makes sonner update the toast in place. */
const STALE_BUILD_TOAST_ID = "stale-build";

/**
 * A tab that outlived a deploy still runs the PREVIOUS build. Server actions
 * are addressed by build-specific ids, so the new server answers every call
 * from that tab with "action not found", which Next surfaces as
 * `UnrecognizedActionError`. No retry can succeed: only loading the new
 * build does.
 *
 * So say so, and let the person reload when they are ready. Never reload for
 * them: the error fires on a background refetch (window focus), and an
 * automatic reload would throw away whatever they were typing. Every other
 * error passes through untouched.
 */
export const notifyIfStaleBuild = (error: unknown): void => {
  if (!unstable_isUnrecognizedActionError(error)) return;
  toast("A new version of OneCLI is available.", {
    id: STALE_BUILD_TOAST_ID,
    description: "Reload the page to keep going.",
    duration: Infinity,
    action: { label: "Reload", onClick: () => window.location.reload() },
  });
};
