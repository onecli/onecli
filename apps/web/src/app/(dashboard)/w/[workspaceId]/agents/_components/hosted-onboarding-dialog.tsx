"use client";

import { CalendarClock, ArrowUpRight } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Button } from "@onecli/ui/components/button";
import { ONBOARDING_CALL_URL } from "@/lib/agents/create-door";

interface HostedOnboardingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * What a legacy (BYO) user meets when they reach for a hosted agent.
 *
 * Not a create form: their existing setup — keys, scripts, whatever their
 * agents already run on — has to come with them, and none of that is a field
 * in a dialog yet. So the honest answer is fifteen minutes with a human, and
 * the dialog says exactly that rather than dressing a sales call as a feature.
 */
export const HostedOnboardingDialog = ({
  open,
  onOpenChange,
}: HostedOnboardingDialogProps) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent>
      <div className="flex flex-col items-center pt-2 text-center">
        <div className="bg-brand/10 mb-3 flex size-10 items-center justify-center rounded-full">
          <CalendarClock className="text-brand size-5" aria-hidden />
        </div>
        <DialogHeader className="items-center">
          <DialogTitle>
            Let&apos;s set your hosted agent up together
          </DialogTitle>
          <DialogDescription>
            Hosted agents run on our computers instead of yours. Moving your
            existing setup across takes about fifteen minutes with us on the
            call. We&apos;ll bring your connections over and leave you with an
            agent that works.
          </DialogDescription>
        </DialogHeader>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Not now
        </Button>
        <Button asChild>
          {/* A new tab: leaving the dashboard mid-flow to book a call and
              losing the page you were on is its own small betrayal. */}
          <a
            href={ONBOARDING_CALL_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => onOpenChange(false)}
          >
            Book 15 minutes
            <ArrowUpRight className="size-3.5" aria-hidden />
            {/* A new tab is a surprise unless it's announced. */}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);
