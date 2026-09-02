"use client";

import { useState } from "react";
import { Loader2, Plus, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import {
  useOrgSkills,
  useSkills,
  useUpdateOrgSkill,
  useUpdateSkill,
} from "@/hooks/use-skills";
import type { SkillSummary } from "@/lib/api";
import { SkillRow } from "./skill-row";
import { SkillDialog } from "./skill-dialog";

/**
 * The Skills section, parameterized by door.
 *
 * - `agent` — the agent page's section (§3.18 as amended): skills are a
 *   property of an AGENT, so this is where they are written. It lists this
 *   agent's own rows plus everything it INHERITS (workspace and organization
 *   tiers), because what the agent carries is the merged set and hiding the
 *   inherited half would make its behavior unexplainable.
 * - `organization` — the org door: org rows only.
 *
 * Org rows are read-only away from the org page (they are managed there);
 * workspace-tier rows stay editable from any agent that inherits them, with a
 * label saying whom else they reach, so an edit is never a surprise.
 */
export type SkillsSectionProps =
  /** The org door: org rows only. */
  | { tier: "organization"; agentId?: never }
  /** The agent door: whose section this is — the id is not optional, or a
   *  missing one would silently filter every agent row out. */
  | { tier: "agent"; agentId: string };

export const SkillsSection = ({ tier, agentId }: SkillsSectionProps) => {
  const isOrg = tier === "organization";
  // Each read is mounted only on the door that shows it: /v1/skills sends no
  // workspace header from an /org/ URL (a 401 on cloud, someone else's default
  // workspace onprem).
  const workspaceView = useSkills(!isOrg);
  const orgView = useOrgSkills(isOrg);
  const view = isOrg ? orgView : workspaceView;
  const update = useUpdateSkill();
  const orgUpdate = useUpdateOrgSkill();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<SkillSummary | null>(null);

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (skill: SkillSummary) => {
    setEditing(skill);
    setDialogOpen(true);
  };

  if (view.isPending) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
        <span className="sr-only">Loading skills</span>
      </div>
    );
  }

  // Never render mutating controls over a failed load — a blind edit would
  // write against invisible state (the apps-tab law).
  if (view.isError) {
    return (
      <div
        role="alert"
        className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border p-4 text-sm"
      >
        Skills failed to load. Refresh to try again.
      </div>
    );
  }

  // The agent door shows what THIS agent carries: its own rows plus the
  // tiers above it. Another agent's rows are none of its business.
  const rows = isOrg
    ? view.data.skills
    : view.data.skills.filter(
        (skill) => skill.scope !== "agent" || skill.agentId === agentId,
      );

  const scopeLabel = (skill: SkillSummary): string => {
    if (skill.scope === "organization") return "Organization";
    // Only the agent door can see an agent row (the org list holds org rows
    // alone), and its own rows need no "who": say what they are.
    if (skill.scope === "agent") return "This agent";
    return "Workspace";
  };

  const toggle = (skill: SkillSummary, next: boolean) => {
    const handlers = {
      onSuccess: () =>
        toast.success(
          next ? `"${skill.name}" resumed` : `"${skill.name}" paused`,
        ),
      onError: (error: Error) => toast.error(String(error.message)),
    };
    const payload = { skillId: skill.id, patch: { enabled: next } };
    if (isOrg) orgUpdate.mutate(payload, handlers);
    else update.mutate(payload, handlers);
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        {rows.length > 0 && (
          <Button size="sm" onClick={openCreate}>
            <Plus className="size-4" />
            New skill
          </Button>
        )}
      </div>

      {rows.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 p-8 text-center">
          <div className="bg-muted flex size-10 items-center justify-center rounded-full">
            <Sparkles className="text-muted-foreground size-5" />
          </div>
          <div>
            <p className="text-sm font-medium">No skills yet</p>
            <p className="text-muted-foreground mt-1 text-sm">
              Write down how you want something done, once. This agent picks it
              up within seconds, or at its next start if it is asleep.
            </p>
          </div>
          <Button size="sm" onClick={openCreate}>
            <Plus className="size-4" />
            New skill
          </Button>
        </Card>
      ) : (
        <div className="divide-y rounded-md border">
          {rows.map((skill) => {
            // Org rows away from the org page are managed at org level — no
            // edit, no toggle, just the pointer.
            const readOnly = !isOrg && skill.scope === "organization";
            return (
              <SkillRow
                key={skill.id}
                skill={skill}
                scopeLabel={scopeLabel(skill)}
                onEdit={readOnly ? undefined : () => openEdit(skill)}
                onToggle={readOnly ? undefined : (next) => toggle(skill, next)}
                toggling={update.isPending || orgUpdate.isPending}
              />
            );
          })}
        </div>
      )}

      <SkillDialog
        tier={tier}
        agentId={agentId}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
      />
    </div>
  );
};
