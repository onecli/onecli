"use client";

import { Badge } from "@onecli/ui/components/badge";
import { detectAnthropicAuthMode } from "@onecli/api/validations/secret";

/**
 * Names the KIND of Anthropic credential pasted, in the words the hint uses:
 * a Claude Console API key (`sk-ant-api…`, metered API billing) or a
 * subscription token (`sk-ant-oat…`, what `claude setup-token` prints, billed
 * to the Claude plan). Anything else (an Admin key, a foreign key) gets no
 * badge; the inline warning explains it instead.
 */
export const AnthropicKeyBadge = ({ value }: { value: string }) => {
  const detected = detectAnthropicAuthMode(value);
  if (!detected) return null;

  return (
    <Badge
      variant="outline"
      className="text-muted-foreground animate-in fade-in shrink-0 gap-1.5 text-[10px] font-normal motion-reduce:animate-none"
    >
      <span
        aria-hidden="true"
        className={
          detected === "api-key"
            ? "bg-brand size-1.5 rounded-full"
            : "bg-blue-500 size-1.5 rounded-full"
        }
      />
      {detected === "api-key" ? "API Key" : "Subscription"}
    </Badge>
  );
};
