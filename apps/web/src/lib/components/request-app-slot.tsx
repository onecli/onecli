import { Plus } from "lucide-react";

/**
 * OSS default "Request an app" slot — links to the OSS repo's issue form
 * pre-labeled `app-request`.
 *
 * Cloud aliases this module to `@/cloud/apps/request-app-slot` via
 * turbopack `resolveAlias` in `next.config.js`. The cloud override opens
 * an in-app dialog that collects the request and emails the user an
 * acknowledgment via Resend.
 */

const ISSUE_BODY_TEMPLATE = `**Website:**

**How you'd use this with OneCLI:**
`;

const GITHUB_ISSUE_URL = `https://github.com/onecli/onecli/issues/new?${new URLSearchParams(
  {
    labels: "app request",
    title: "App request: ",
    body: ISSUE_BODY_TEMPLATE,
  },
).toString()}`;

export const RequestAppSlot = () => (
  <a
    href={GITHUB_ISSUE_URL}
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
