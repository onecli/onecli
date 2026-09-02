"use client";

import { cn } from "@onecli/ui/lib/utils";
import type { ChannelTransport } from "@/lib/api";
import { selectableCard } from "@/lib/onboarding/_components/selectable";

interface SlackTransportPickerProps {
  value: ChannelTransport;
  onValueChange: (transport: ChannelTransport) => void;
}

const OPTIONS: {
  transport: ChannelTransport;
  title: string;
  description: string;
}[] = [
  {
    transport: "events",
    title: "Webhooks",
    description:
      "Slack calls your deployment over public HTTPS. One-click install.",
  },
  {
    transport: "socket",
    title: "Socket Mode",
    description:
      "Your deployment connects out to Slack. Works without a public URL.",
  },
];

/**
 * The connection-mode choice, shown only when the deployment can serve more
 * than one transport (a TLS'd self-host). The mode is baked into the Slack
 * app at create time, so this is decided before the attach starts.
 *
 * Full WAI-ARIA radio contract (the secret-dialog "Inject as" precedent):
 * roving tabindex + arrow-key movement — announcing `radio` without them
 * promises an interaction that never comes.
 */
export const SlackTransportPicker = ({
  value,
  onValueChange,
}: SlackTransportPickerProps) => (
  <div
    role="radiogroup"
    aria-label="Connection mode"
    className="grid gap-2 sm:grid-cols-2"
    onKeyDown={(e) => {
      if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(e.key))
        return;
      e.preventDefault();
      const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
      const current = OPTIONS.findIndex((o) => o.transport === value);
      const nextIdx = (current + delta + OPTIONS.length) % OPTIONS.length;
      const next = OPTIONS[nextIdx];
      if (!next) return;
      onValueChange(next.transport);
      e.currentTarget
        .querySelectorAll<HTMLButtonElement>('[role="radio"]')
        [nextIdx]?.focus();
    }}
  >
    {OPTIONS.map((option) => (
      <button
        key={option.transport}
        type="button"
        role="radio"
        aria-checked={value === option.transport}
        tabIndex={value === option.transport ? 0 : -1}
        onClick={() => onValueChange(option.transport)}
        className={cn(
          "rounded-lg p-3 text-left",
          selectableCard(value === option.transport),
        )}
      >
        <span className="block text-sm font-medium">{option.title}</span>
        <span className="text-muted-foreground mt-0.5 block text-xs">
          {option.description}
        </span>
      </button>
    ))}
  </div>
);
