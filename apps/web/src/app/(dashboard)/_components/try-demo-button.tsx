"use client";

import { useState } from "react";
import { Terminal } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import { TryDemoDialog } from "./try-demo-dialog";

export const TryDemoButton = () => {
  const [dialogOpen, setDialogOpen] = useState(false);

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
      <TryDemoDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
};
