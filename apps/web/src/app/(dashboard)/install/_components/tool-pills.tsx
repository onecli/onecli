"use client";

import { useState } from "react";
import Image from "next/image";
import { Terminal } from "lucide-react";
import { cn } from "@onecli/ui/lib/utils";
import { CODING_TOOLS, type CodingToolId } from "@/lib/install-command";

export type ToolSelection = CodingToolId | "other";

interface ToolPillsProps {
  value: ToolSelection;
  onChange: (value: ToolSelection) => void;
}

export const ToolPills = ({ value, onChange }: ToolPillsProps) => {
  const [iconErrors, setIconErrors] = useState<ReadonlySet<string>>(new Set());

  const pill = (
    id: ToolSelection,
    name: string,
    icon: React.ReactNode,
  ): React.ReactNode => (
    <button
      key={id}
      type="button"
      aria-pressed={value === id}
      onClick={() => onChange(id)}
      className={cn(
        "flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors",
        value === id
          ? "border-brand bg-brand/10 font-medium"
          : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
      )}
    >
      {icon}
      {name}
    </button>
  );

  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Coding tool">
      {CODING_TOOLS.map((tool) =>
        pill(
          tool.id,
          tool.name,
          iconErrors.has(tool.id) ? (
            <Terminal aria-hidden className="size-4" />
          ) : (
            <Image
              src={tool.icon}
              alt=""
              aria-hidden
              width={16}
              height={16}
              className="rounded-[3px]"
              onError={() =>
                setIconErrors((prev) => new Set([...prev, tool.id]))
              }
            />
          ),
        ),
      )}
      {pill("other", "Other", <Terminal aria-hidden className="size-4" />)}
    </div>
  );
};
