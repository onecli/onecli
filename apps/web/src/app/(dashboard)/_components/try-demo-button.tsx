"use client";

import { useState, useEffect } from "react";
import { Terminal } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import { useAuth } from "@/providers/auth-provider";
import { getDemoInfo } from "@/lib/actions/secrets";
import { TryDemoDialog } from "./try-demo-dialog";

export const TryDemoButton = () => {
  const { user: authUser } = useAuth();
  const [demoInfo, setDemoInfo] = useState<{
    agentToken: string | null;
  } | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    if (!authUser?.id) return;
    getDemoInfo(authUser.id).then(setDemoInfo);
  }, [authUser?.id]);

  if (!demoInfo?.agentToken) return null;

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="brand" size="sm" onClick={() => setDialogOpen(true)}>
            <Terminal className="size-3.5" />
            Try it
          </Button>
        </TooltipTrigger>
        <TooltipContent>Run a quick test of secret injection</TooltipContent>
      </Tooltip>
      <TryDemoDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        agentToken={demoInfo.agentToken}
      />
    </>
  );
};
