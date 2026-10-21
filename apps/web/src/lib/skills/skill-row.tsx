"use client";

import Link from "next/link";
import { ExternalLink, Pencil } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Switch } from "@onecli/ui/components/switch";
import { formatRelative } from "@onecli/api/lib/format";
import type { SkillSummary } from "@/lib/api";
import { SkillSourceChip, type SkillSourceKind } from "./skill-source-chip";

export interface SkillRowProps {
  skill: SkillSummary;
  /** Where the skill comes from (the colored chip). */
  kind: SkillSourceKind;
  /** Present = editable here; absent = managed elsewhere (org rows on the
   * agent page, which link to the org page instead). */
  onEdit?: () => void;
  /** Present alongside `onEdit`: pause/resume without opening the dialog.
   * Instant (optimistic), so the switch is never frozen while it saves. */
  onToggle?: (next: boolean) => void;
}

export const SkillRow = ({ skill, kind, onEdit, onToggle }: SkillRowProps) => (
  <div className="flex items-center gap-3 p-3">
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline gap-2">
        <span className="truncate font-mono text-sm font-medium">
          {skill.name}
        </span>
        <SkillSourceChip kind={kind} />
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
