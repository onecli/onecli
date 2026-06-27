"use client";

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@onecli/ui/components/input";
import { cn } from "@onecli/ui/lib/utils";

interface PasswordInputProps extends React.ComponentProps<typeof Input> {
  /**
   * Called when the eye is clicked while the field is EMPTY — i.e. the user
   * wants to reveal a previously-saved secret rather than what they typed.
   * Return true if a value was revealed (the input becomes visible), false
   * otherwise (e.g. reveal disabled; the handler surfaces its own message).
   */
  onRevealRequest?: () => Promise<boolean>;
}

/**
 * Password input with a show/hide eye toggle. When the field is empty and an
 * `onRevealRequest` handler is provided, the eye instead asks to reveal the
 * saved secret (gated server-side); otherwise it just toggles what was typed.
 */
export const PasswordInput = ({
  className,
  onRevealRequest,
  value,
  ...props
}: PasswordInputProps) => {
  const [visible, setVisible] = useState(false);

  const hasTyped = typeof value === "string" && value.length > 0;

  const handleEye = async () => {
    if (visible) {
      setVisible(false);
      return;
    }
    // Nothing typed + a reveal handler ⇒ try to reveal the saved value.
    if (!hasTyped && onRevealRequest) {
      const ok = await onRevealRequest();
      if (ok) setVisible(true);
      return;
    }
    setVisible(true);
  };

  return (
    <div className="relative">
      <Input
        {...props}
        value={value}
        type={visible ? "text" : "password"}
        className={cn("pr-10", className)}
      />
      <button
        type="button"
        onClick={handleEye}
        className="text-muted-foreground hover:text-foreground absolute inset-y-0 right-0 flex items-center pr-3 transition-colors"
        aria-label={visible ? "Hide value" : "Show value"}
        tabIndex={-1}
      >
        {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
};
