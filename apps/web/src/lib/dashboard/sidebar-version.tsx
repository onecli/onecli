"use client";

import { Check, Copy } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@onecli/ui/components/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useInstance } from "@/hooks/use-instance";
import { APP_VERSION, IS_CLOUD } from "@/lib/env";
import type { InstanceInfo } from "@/lib/api/types";

// Both commands byte-exact from scripts/install.sh and docs/self-hosting.md —
// re-running the install front door IS the upgrade (a bare `docker compose
// pull` leaves the agent sandbox image stale).
const INSTALL_COMMAND = "curl -fsSL https://onecli.sh/install | sh";
const CHECKOUT_COMMAND = "git pull && pnpm install && pnpm run setup --upgrade";

/**
 * Which version the indicator shows, or null to render nothing.
 *
 * The API's version (what an upgrade actually changes) wins; the web bundle's
 * baked version covers source builds and `pnpm dev`, where the api-server has
 * no APP_VERSION and reports "unknown". Never render "unknown" or "dev".
 */
export const displayVersion = (
  instance: Pick<InstanceInfo, "edition" | "version"> | null,
  baked: string,
): string | null => {
  if (!instance) return null;
  if (instance.edition !== "onprem") return null;
  if (instance.version && instance.version !== "unknown") {
    return instance.version;
  }
  return baked !== "dev" ? baked : null;
};

/**
 * Self-host only: the installed OneCLI version, as a muted caption at the
 * bottom of the sidebar footer. Hover names the deployment; clicking opens a
 * minimal how-to-update dialog. Static text only — deliberately no
 * "update available" check (this product never registry-polls instances).
 */
export const SidebarVersion = () => {
  const instance = useInstance();
  const { copied, copy } = useCopyToClipboard();
  if (IS_CLOUD) return null;
  const version = displayVersion(instance, APP_VERSION);
  if (!version) return null;

  return (
    <Dialog>
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            <button
              type="button"
              aria-label={`OneCLI version ${version}, update instructions`}
              className="text-muted-foreground/70 hover:text-muted-foreground focus-visible:ring-ring self-start rounded-sm px-2 py-1 text-left text-[11px] tabular-nums transition-colors focus-visible:ring-1 focus-visible:outline-none group-data-[collapsible=icon]:hidden"
            >
              v{version}
            </button>
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent side="right">
          OneCLI v{version} · Self-hosted
        </TooltipContent>
      </Tooltip>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>OneCLI v{version}</DialogTitle>
          <DialogDescription>
            Self-hosted. To update, re-run the installer:
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <pre className="bg-muted rounded-md border p-3 pr-10 font-mono text-xs break-all whitespace-pre-wrap">
            {INSTALL_COMMAND}
          </pre>
          <Button
            variant="ghost"
            size="icon"
            className="absolute top-1.5 right-1.5"
            onClick={() => copy(INSTALL_COMMAND)}
          >
            {copied ? (
              <Check className="size-4" />
            ) : (
              <Copy className="size-4" />
            )}
            <span className="sr-only">Copy install command</span>
            <span aria-live="polite" className="sr-only">
              {copied ? "Copied" : ""}
            </span>
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          Installed from a checkout? Run{" "}
          <code className="font-mono">{CHECKOUT_COMMAND}</code> instead.
        </p>
      </DialogContent>
    </Dialog>
  );
};
