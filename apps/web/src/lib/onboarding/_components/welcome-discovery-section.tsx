"use client";

import { Search, BrainCircuit, Users, Github, Smile } from "lucide-react";
import { cn } from "@onecli/ui/lib/utils";
import { selectableCard } from "./selectable";

const DISCOVERY_OPTIONS = [
  { id: "twitter", label: "Twitter / X", icon: XIcon },
  { id: "google", label: "Google", icon: Search },
  { id: "llm", label: "LLM", icon: BrainCircuit },
  { id: "friend", label: "Friend", icon: Users },
  { id: "open-source", label: "Open Source", icon: Github },
  { id: "other", label: "Other", icon: Smile },
] as const;

interface WelcomeDiscoverySectionProps {
  selected: Set<string>;
  onToggle: (id: string) => void;
}

/** Just the option grid — the step page owns the question headline, so the
 * three steps share one heading rhythm. */
export const WelcomeDiscoverySection = ({
  selected,
  onToggle,
}: WelcomeDiscoverySectionProps) => {
  return (
    <div className="grid w-full grid-cols-2 gap-3 sm:grid-cols-3">
      {DISCOVERY_OPTIONS.map((option, i) => {
        const Icon = option.icon;
        const isSelected = selected.has(option.id);

        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={isSelected}
            onClick={() => onToggle(option.id)}
            style={{ animationDelay: `${i * 60}ms` }}
            className={cn(
              "flex items-center justify-center gap-2 rounded-xl px-4 py-3.5 text-sm font-medium",
              "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 fill-mode-both",
              selectableCard(isSelected),
            )}
          >
            <Icon className="size-4 shrink-0" />
            {option.label}
          </button>
        );
      })}
    </div>
  );
};

function XIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}
