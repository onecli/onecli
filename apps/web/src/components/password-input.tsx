"use client";

import { forwardRef, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@onecli/ui/components/input";
import { cn } from "@onecli/ui/lib/utils";

/**
 * A password field with a reveal toggle.
 *
 * Separate from `secret-input`, which looks similar but is not this: that one
 * is a fixed-shape control for stored credentials — monospaced, labelled
 * "secret", and closed to the props a real form field needs (`autoComplete`,
 * `name`, `required`, key handling). This forwards everything through to the
 * underlying input.
 *
 * The toggle is `tabIndex={-1}` so tabbing runs email → password → submit
 * rather than detouring through it.
 */
export const PasswordInput = forwardRef<
  HTMLInputElement,
  Omit<React.ComponentProps<"input">, "type">
>(({ className, ...props }, ref) => {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <Input
        ref={ref}
        type={visible ? "text" : "password"}
        className={cn("pr-10", className)}
        {...props}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        className="text-muted-foreground hover:text-foreground absolute top-1/2 right-3 -translate-y-1/2 transition-colors"
        tabIndex={-1}
        aria-label={visible ? "Hide password" : "Show password"}
      >
        {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
});

PasswordInput.displayName = "PasswordInput";
