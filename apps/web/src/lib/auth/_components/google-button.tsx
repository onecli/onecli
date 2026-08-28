"use client";

import { Button } from "@onecli/ui/components/button";
import { GoogleIcon } from "@/lib/components/google-icon";

export interface GoogleButtonProps {
  label: string;
  pending: boolean;
  disabled?: boolean;
  onClick: () => void;
}

/** The "Continue with Google" button, shown only where Google is configured. */
export const GoogleButton = ({
  label,
  pending,
  disabled,
  onClick,
}: GoogleButtonProps) => (
  <Button
    size="lg"
    variant="outline"
    className="w-full gap-2 bg-white text-base text-black hover:bg-gray-100 dark:bg-white dark:text-black dark:hover:bg-gray-100"
    loading={pending}
    disabled={disabled}
    onClick={onClick}
  >
    {/* Omitted while loading: the button prepends its own spinner, and both
        would show at once. */}
    {!pending && <GoogleIcon />}
    {pending ? "Redirecting..." : label}
  </Button>
);
