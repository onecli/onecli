"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import { ConnectAppPickerDialog } from "../../_components/connect-app-picker-dialog";
import { GreetingConnectCard } from "./greeting-connect-card";

/**
 * What sits under the onboarding agent's first message (its own words, see
 * greeting-service): the one-click Gmail row the message just pointed at,
 * and a button that opens the full app picker in place for any other tool.
 * Also under a greeting that could not be answered, so the first step is
 * still one click away when the agent cannot speak yet.
 */
export const GreetingActions = () => {
  const params = useParams<{ agentId?: string }>();
  const agentId = params?.agentId ?? "";
  const [pickerOpen, setPickerOpen] = useState(false);
  // Lazy-mount latch, the connect card's own rule: nothing mounts until the
  // first open, but once opened the picker STAYS mounted (closed), so a
  // popup started from it and finished after the dialog closed still
  // reaches its listener and refreshes this agent's grants.
  const [pickerMounted, setPickerMounted] = useState(false);

  return (
    <div
      data-testid="greeting-actions"
      className="motion-safe:animate-in motion-safe:fade-in flex flex-col items-start gap-3"
    >
      <div className="w-full">
        <GreetingConnectCard variant="greeting" />
      </div>
      {agentId && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setPickerMounted(true);
            setPickerOpen(true);
          }}
          className="border-brand/30 bg-brand/10 text-foreground hover:bg-brand/15 hover:text-foreground rounded-full"
        >
          <Plus aria-hidden />
          Add different tools
        </Button>
      )}
      {agentId && pickerMounted && (
        <ConnectAppPickerDialog
          agentId={agentId}
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          onConnected={() => toast.success("Connected and on for this agent.")}
        />
      )}
    </div>
  );
};
