"use client";

import Link from "next/link";
import { ExternalLink, Pencil } from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import { Switch } from "@onecli/ui/components/switch";
import { formatRelative } from "@onecli/api/lib/format";
import type { SkillSummary } from "@/lib/api";

export interface SkillRowProps {
  skill: SkillSummary;
  /** The scope label ("Organization" / "Workspace" / the agent's name). */
  scopeLabel: string;
  /** Present = editable here; absent = managed elsewhere (org rows on the
   * workspace page, which link to the org page instead). */
  onEdit?: () => void;
  /** Present alongside `onEdit`: pause/resume without opening the dialog. */
  onToggle?: (next: boolean) => void;
  toggling?: boolean;
}

export const SkillRow = ({
  skill,
  scopeLabel,
  onEdit,
  onToggle,
  toggling,
}: SkillRowProps) => (
  <div className="flex items-center gap-3 p-3">
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline gap-2">
        <span className="truncate font-mono text-sm font-medium">
          {skill.name}
        </span>
        {/* An agent's name is free-form and up to 255 chars, and Badge is
            `shrink-0` — clip inside it rather than let one row shove its
            controls off the edge. */}
        <Badge variant="outline" className="min-w-0 max-w-40">
          <span className="truncate">{scopeLabel}</span>
        </Badge>
      </div>
      <p
        className="text-muted-foreground mt-0.5 truncate text-sm"
        title={skill.description}
      >
        {skill.description}
      </p>
      <p className="text-muted-foreground/80 mt-0.5 text-xs">
        Updated {formatRelative(skill.updatedAt)}
        {skill.fileCount > 0 &&
          ` · ${skill.fileCount} extra file${skill.fileCount === 1 ? "" : "s"}`}
      </p>
    </div>
    {onEdit ? (
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Edit ${skill.name}`}
          onClick={onEdit}
        >
          <Pencil className="size-4" />
        </Button>
        {/* The switch IS the status — there is no separate "Paused" badge,
            because every state it can be in, it expresses. */}
        {onToggle && (
          <Switch
            size="sm"
            checked={skill.enabled}
            disabled={toggling}
            aria-label={`${skill.enabled ? "Pause" : "Resume"} ${skill.name}`}
            onCheckedChange={onToggle}
          />
        )}
      </div>
    ) : (
      <Button
        asChild
        variant="ghost"
        size="icon-xs"
        aria-label={`Manage ${skill.name} at the organization level`}
      >
        <Link href={`/org/${skill.organizationId}/skills`}>
          <ExternalLink className="size-4" />
        </Link>
      </Button>
    )}
  </div>
);
