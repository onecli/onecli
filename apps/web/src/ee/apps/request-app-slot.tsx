"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import type { RequestAppSlotProps } from "@/lib/components/request-app-slot";
import { RequestAppDialog } from "./request-app-dialog";

/**
 * Cloud arm of the `@/lib/components/request-app-slot` dispatcher.
 *
 * Rendered as the first item in the Apps grid. Opens a dialog that
 * collects an app name (required) and website URL (optional), sends the
 * user an acknowledgment email via Resend, and pings Discord.
 *
 * Accepts optional controlled props so the parent can open the dialog
 * programmatically (e.g., via `?request=` URL param from the gateway).
 */
export const RequestAppSlot = ({
  requestOpen,
  onRequestOpenChange,
  initialName,
  initialUrl,
}: RequestAppSlotProps = {}) => {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = requestOpen ?? internalOpen;
  const setOpen = onRequestOpenChange ?? setInternalOpen;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group flex h-full items-center rounded-lg border border-dashed border-muted-foreground/40 bg-card/40 px-3.5 py-3 text-left transition-colors cursor-pointer hover:bg-accent/50 hover:border-solid"
      >
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background">
            <Plus className="size-4 text-muted-foreground transition-colors group-hover:text-foreground" />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-medium">Request an app</span>
            <span className="text-muted-foreground text-xs">
              We&apos;ll add it for you
            </span>
          </div>
        </div>
      </button>

      <RequestAppDialog
        open={open}
        onOpenChange={setOpen}
        initialName={initialName}
        initialUrl={initialUrl}
      />
    </>
  );
};
