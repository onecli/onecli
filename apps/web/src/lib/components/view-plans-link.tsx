"use client";

import Link from "next/link";
import { Button } from "@onecli/ui/components/button";
import { useSettingsHref } from "@/lib/settings-modal/use-settings-href";

/** Cloud: plans are bought in the product, at Settings > Billing & usage. */
export const ViewPlansLink = ({ className }: { className?: string }) => {
  const settingsHref = useSettingsHref();
  return (
    <Button asChild className={className}>
      <Link href={settingsHref("billing")}>View plans</Link>
    </Button>
  );
};
