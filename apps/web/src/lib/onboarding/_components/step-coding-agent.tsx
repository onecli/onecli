"use client";

import { useState } from "react";
import Image from "next/image";
import { Ellipsis } from "lucide-react";
import { AgentIcon } from "@/lib/agents/agent-icon";
import { cn } from "@onecli/ui/lib/utils";
import { Input } from "@onecli/ui/components/input";
import { selectableCard } from "./selectable";

interface StepCodingAgentProps {
  selected: string | null;
  otherValue: string;
  onSelect: (agent: string) => void;
  onOtherChange: (value: string) => void;
  onConfirmOther: () => void;
}

const CODING_AGENTS = [
  { id: "claude-code", name: "Claude Code", icon: "/icons/claude-code.svg" },
  { id: "cursor", name: "Cursor", icon: "/icons/cursor.svg" },
  { id: "codex", name: "Codex", icon: "/icons/codex.svg" },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    icon: "/icons/github-copilot.svg",
  },
] as const;

export const StepCodingAgent = ({
  selected,
  otherValue,
  onSelect,
  onOtherChange,
  onConfirmOther,
}: StepCodingAgentProps) => {
  const [imgErrors, setImgErrors] = useState<Set<string>>(() => new Set());

  return (
    <div className="flex w-full flex-col items-center">
      <div className="mb-10 text-center">
        <h1 className="text-3xl font-bold tracking-tight">
          Which coding agent do you use?
        </h1>
        <p className="text-muted-foreground mt-2 text-sm">
          We&apos;ll tailor the setup commands to it.
        </p>
      </div>

      <div className="grid w-full max-w-2xl grid-cols-2 gap-4 sm:grid-cols-3">
        {CODING_AGENTS.map((agent, i) => (
          <button
            key={agent.id}
            type="button"
            aria-pressed={selected === agent.id}
            onClick={() => onSelect(agent.id)}
            style={{ animationDelay: `${i * 60}ms` }}
            className={cn(
              "group flex flex-col items-center gap-4 rounded-2xl p-6 duration-200",
              "animate-in fade-in slide-in-from-bottom-2 fill-mode-both",
              selectableCard(selected === agent.id),
            )}
          >
            <div className="flex size-14 items-center justify-center transition-transform duration-200 group-hover:scale-125">
              {imgErrors.has(agent.id) ? (
                <AgentIcon className="text-muted-foreground size-7" />
              ) : (
                <Image
                  src={agent.icon}
                  alt={agent.name}
                  width={32}
                  height={32}
                  onError={() =>
                    setImgErrors((prev) => new Set([...prev, agent.id]))
                  }
                />
              )}
            </div>
            <p className="text-sm font-semibold">{agent.name}</p>
          </button>
        ))}

        <button
          type="button"
          aria-pressed={selected === "other"}
          onClick={() => onSelect("other")}
          style={{ animationDelay: `${CODING_AGENTS.length * 60}ms` }}
          className={cn(
            "group flex flex-col items-center gap-4 rounded-2xl p-6 duration-200",
            "animate-in fade-in slide-in-from-bottom-2 fill-mode-both",
            selectableCard(selected === "other"),
          )}
        >
          <div className="flex size-14 items-center justify-center transition-transform duration-200 group-hover:scale-125">
            <Ellipsis className="text-muted-foreground size-7" />
          </div>
          <p className="text-sm font-semibold">Other</p>
        </button>
      </div>

      {selected === "other" && (
        <div className="mt-6 w-full max-w-xs animate-in fade-in slide-in-from-top-1">
          <Input
            placeholder="What's your coding agent called?"
            value={otherValue}
            onChange={(e) => onOtherChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && otherValue.trim()) onConfirmOther();
            }}
            className="text-center"
            autoFocus
          />
        </div>
      )}
    </div>
  );
};
