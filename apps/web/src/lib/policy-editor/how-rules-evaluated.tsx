"use client";

import { Info } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@onecli/ui/components/popover";
// Alias key on purpose (the edition seam): EE reads `true` and gets the
// two-level explainer; OSS reads `false` and gets the single-list one.
import { ORG_GUARDRAILS_AVAILABLE } from "@/lib/policy-editor/editor-chrome";

/**
 * A quiet "how rules are evaluated" affordance for the policy console. It spells
 * out the top-down first-match model precisely — the part the subtitle can't
 * carry without becoming a paragraph, and the two things people otherwise get
 * wrong: the Default Rule catch-all, and that modifiers don't stack. The EE
 * editions describe the two-level (org guardrails + project) model; OSS has no
 * organization level, so it describes the single project list.
 */
export const HowRulesEvaluated = () => (
  <Popover>
    <PopoverTrigger asChild>
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground gap-1.5"
      >
        <Info className="size-4" aria-hidden />
        {/* Icon-only beside the filter on small screens; the label stays
            readable to assistive tech either way. */}
        <span className="max-sm:sr-only">How rules are evaluated</span>
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" className="w-96">
      <p className="text-sm font-medium">How rules are evaluated</p>
      <p className="text-muted-foreground mt-1 text-xs">
        For each request an agent makes:
      </p>
      {ORG_GUARDRAILS_AVAILABLE ? (
        <ol className="text-muted-foreground mt-2 ml-4 list-decimal space-y-1.5 text-xs">
          <li>
            <span className="text-foreground">Organization guardrails</span> are
            checked top-down — the first rule that matches is the org&rsquo;s
            decision.
          </li>
          <li>
            <span className="text-foreground">Project rules</span> are checked
            the same way, in their listed order.
          </li>
          <li>
            The <span className="text-foreground font-medium">stricter</span> of
            the two wins — Block beats Allow, and requiring approval beats a
            rate limit.
          </li>
          <li>
            If no rule at a level matches, that level&rsquo;s{" "}
            <span className="text-foreground">Default Rule</span> gives its
            verdict — the stricter verdict wins.
          </li>
        </ol>
      ) : (
        <ol className="text-muted-foreground mt-2 ml-4 list-decimal space-y-1.5 text-xs">
          <li>
            <span className="text-foreground">Rules</span> are checked top-down,
            in their listed order — the first rule that matches decides.
          </li>
          <li>
            If no rule matches, the{" "}
            <span className="text-foreground">Default Rule</span> gives the
            verdict.
          </li>
        </ol>
      )}
      <p className="text-muted-foreground mt-3 border-t pt-2 text-xs">
        Only one rule ever decides — rate limits and approvals don&rsquo;t
        stack.
      </p>
    </PopoverContent>
  </Popover>
);
