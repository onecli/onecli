"use client";

import { useState } from "react";
import { Rocket } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import { GetStartedDialog } from "./get-started-dialog";

export const GetStartedButton = () => {
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="brand" size="sm" onClick={() => setDialogOpen(true)}>
            <Rocket className="size-3.5" />
            Get Started
          </Button>
        </TooltipTrigger>
        <TooltipContent>Install NanoClaw or try the gateway</TooltipContent>
      </Tooltip>
      <GetStartedDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
};
