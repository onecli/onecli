"use client";

import { ChevronDown, Clock } from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import { openApprovalsBell } from "@/lib/components/approvals/open-approvals-bell";

/** A row whose ask is still open. Clicking opens the approvals bell, the
 *  one inbox where it is decided, instead of a second menu here. */
export const WaitingForApprovalBadge = () => (
  <Button
    variant="ghost"
    size="sm"
    className="gap-1.5 px-2"
    onClick={openApprovalsBell}
    aria-label="Waiting for approval. Open pending approvals"
  >
    <Badge
      variant="secondary"
      className="border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
    >
      <Clock className="size-3" aria-hidden />
      Waiting for approval
    </Badge>
    <ChevronDown className="text-muted-foreground size-3.5" aria-hidden />
  </Button>
);
