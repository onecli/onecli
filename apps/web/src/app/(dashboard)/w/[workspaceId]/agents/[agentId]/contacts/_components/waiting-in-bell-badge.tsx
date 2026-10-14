"use client";

import { Clock } from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";

/** A half whose ask is still open. It is decided in the approvals bell,
 *  the one inbox, so the row only says where the wait is. */
export const WaitingInBellBadge = () => (
  <Badge
    variant="secondary"
    className="border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
  >
    <Clock className="size-3" aria-hidden />
    Waiting in the bell
  </Badge>
);
