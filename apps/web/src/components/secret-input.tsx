"use client";

import { forwardRef, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@onecli/ui/components/input";
import { cn } from "@onecli/ui/lib/utils";

export interface SecretInputProps {
  id?: string;
  name?: string;
  "aria-describedby"?: string;
  "aria-required"?: React.AriaAttributes["aria-required"];
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
}

export const SecretInput = forwardRef<HTMLInputElement, SecretInputProps>(
  (
    {
      id,
      name,
      "aria-describedby": describedBy,
      "aria-required": ariaRequired,
      value,
      onChange,
      placeholder,
      autoFocus,
      className,
    },
    ref,
  ) => {
    const [visible, setVisible] = useState(false);

    return (
      <div className="relative">
        <Input
          ref={ref}
          id={id}
          name={name}
          aria-describedby={describedBy}
          aria-required={ariaRequired}
          type={visible ? "text" : "password"}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          className={cn("pr-12 font-mono text-sm", className)}
          autoFocus={autoFocus}
          // These are API credentials, not passwords: the browser's password
          // manager must not offer to save a rotating token.
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="absolute right-0 top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          aria-label={visible ? "Hide secret" : "Show secret"}
        >
          {visible ? (
            <EyeOff aria-hidden="true" className="size-4" />
          ) : (
            <Eye aria-hidden="true" className="size-4" />
          )}
        </button>
      </div>
    );
  },
);

SecretInput.displayName = "SecretInput";
