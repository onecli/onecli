import { Plus } from "lucide-react";
import type { RequestAppSlotProps } from "@/lib/components/request-app-slot";

/**
 * Non-cloud "Request an app" slot — links to the OSS repo's issue form
 * pre-labeled `app request`. Cloud renders the in-app request dialog instead
 * (see the dispatcher in `@/lib/components/request-app-slot`); outside cloud
 * the Resend/Discord plumbing behind that dialog isn't configured, so a
 * GitHub issue is the honest channel.
 *
 * The app name the user searched for pre-fills the issue title, the same
 * prefill the cloud dialog gets. The controlled-dialog props (`requestOpen`
 * etc.) are ignored: there is no dialog to open, the slot is a plain link.
 */

const ISSUE_BODY_TEMPLATE = `**Website:**

**How you'd use this with OneCLI:**
`;

export const appRequestIssueUrl = (appName?: string): string =>
  `https://github.com/onecli/onecli/issues/new?${new URLSearchParams({
    labels: "app request",
    title: `App request: ${appName?.trim() ?? ""}`,
    body: ISSUE_BODY_TEMPLATE,
  }).toString()}`;

export const LocalRequestAppSlot = ({
  initialName,
}: RequestAppSlotProps = {}) => (
  <a
    href={appRequestIssueUrl(initialName)}
    target="_blank"
    rel="noopener noreferrer"
    className="group flex items-center justify-between rounded-xl border border-dashed border-muted-foreground/40 bg-card/40 px-4 py-3 transition-colors cursor-pointer hover:bg-accent/50 hover:border-solid"
  >
    <div className="flex items-center gap-3">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
        <Plus className="size-4 text-muted-foreground transition-colors group-hover:text-foreground" />
      </div>
      <div className="flex flex-col">
        <span className="text-sm font-medium">Request an app</span>
        <span className="text-muted-foreground text-xs">
          Open an issue on GitHub
        </span>
      </div>
    </div>
  </a>
);
