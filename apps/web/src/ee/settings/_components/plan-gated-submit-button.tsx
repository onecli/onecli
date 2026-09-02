"use client";

import { Lock } from "lucide-react";
import { Button } from "@onecli/ui/components/button";

export interface PlanGatedSubmitButtonProps extends Omit<
  React.ComponentProps<typeof Button>,
  "type" | "loading" | "disabled" | "children"
> {
  /**
   * The plan gate locks the feature. The button deliberately stays clickable
   * while locked so the click reaches the form's onSubmit, where the
   * `planGate.guard(...)` call opens the contact-sales paywall.
   */
  locked: boolean;
  pending: boolean;
  /** Whether the form inputs are valid — ignored while locked. */
  complete: boolean;
  pendingLabel: string;
  label: string;
}

export const PlanGatedSubmitButton = ({
  locked,
  pending,
  complete,
  pendingLabel,
  label,
  ...props
}: PlanGatedSubmitButtonProps) => (
  <Button
    type="submit"
    {...props}
    loading={pending}
    disabled={pending || (!locked && !complete)}
  >
    {locked && <Lock className="size-3.5" />}
    {pending ? pendingLabel : label}
  </Button>
);
