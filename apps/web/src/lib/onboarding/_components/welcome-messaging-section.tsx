"use client";

import Image from "next/image";
import { MessageCirclePlus } from "lucide-react";
import { cn } from "@onecli/ui/lib/utils";
import { selectableCard } from "./selectable";

export const MESSAGING_TOOL_OPTIONS = [
  { id: "slack", label: "Slack", logo: "/icons/slack.svg" },
  { id: "teams", label: "Microsoft Teams", logo: "/icons/microsoft-teams.svg" },
  { id: "other", label: "Other", logo: null },
] as const;

export type MessagingToolId = (typeof MESSAGING_TOOL_OPTIONS)[number]["id"];

/** Slack is where most teams already talk, so it starts selected. */
export const DEFAULT_MESSAGING_TOOL: MessagingToolId = "slack";

export interface WelcomeMessagingSectionProps {
  selected: MessagingToolId | null;
  onSelect: (id: MessagingToolId) => void;
}

/** Just the option row: the step page owns the question headline and the
 * "Other" text field, so the grid stays one decision. Single choice, so the
 * buttons are a radio group rather than toggles. Real brand logos for the
 * named tools; "Other" gets a neutral mark of the same size. */
export const WelcomeMessagingSection = ({
  selected,
  onSelect,
}: WelcomeMessagingSectionProps) => (
  <div
    role="radiogroup"
    aria-label="Messaging tool"
    className="grid w-full grid-cols-1 gap-3 sm:grid-cols-3"
  >
    {MESSAGING_TOOL_OPTIONS.map((option, i) => {
      const isSelected = selected === option.id;
      return (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={isSelected}
          onClick={() => onSelect(option.id)}
          style={{ animationDelay: `${i * 60}ms` }}
          className={cn(
            // Tall, even cards with room for the logo tile, so the three
            // choices read as one row of equals.
            "flex min-h-[150px] flex-col items-center justify-center gap-3 rounded-2xl px-4 py-5 text-sm font-medium",
            "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 fill-mode-both",
            selectableCard(isSelected),
          )}
        >
          <span className="bg-card flex size-16 items-center justify-center rounded-2xl border shadow-xs">
            {option.logo ? (
              <Image
                src={option.logo}
                alt=""
                width={32}
                height={32}
                className="size-8 shrink-0"
              />
            ) : (
              <MessageCirclePlus
                className="text-foreground/70 size-8 shrink-0"
                aria-hidden
              />
            )}
          </span>
          {option.label}
        </button>
      );
    })}
  </div>
);
