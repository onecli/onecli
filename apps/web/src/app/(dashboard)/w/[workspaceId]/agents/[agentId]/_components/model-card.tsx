"use client";

import { useId, useState } from "react";
import { Cpu, Loader2 } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import { Label } from "@onecli/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@onecli/ui/components/select";
import { useAgentModels, useUpdateAgentModel } from "@/hooks/use-agents";
import type { AgentEffort } from "@/lib/api/types";

/**
 * What this agent runs, above the keys that decide it (§3.10).
 *
 * Placed here, in the Models section, because "which key is granted" and "what
 * it therefore runs" are one thought — seeing them apart is how a
 * provider-driven switch reads as a surprise instead of a consequence.
 *
 * The card only ever edits an OVERRIDE. Nothing chosen is the normal state,
 * and it is shown as "Default", not as an empty field: the agent is running
 * something either way.
 */

/** The sentinel for "no override" — a Select cannot hold an empty value. */
const DEFAULT = "__default__";

export const ModelCard = ({ agentId }: { agentId: string }) => {
  const modelId = useId();
  const effortId = useId();
  const query = useAgentModels(agentId);
  const update = useUpdateAgentModel();
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [draftEffort, setDraftEffort] = useState<string | null>(null);

  if (query.isPending)
    return (
      <Card
        role="status"
        className="text-muted-foreground flex-row items-center gap-2 p-4 text-sm"
      >
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Loading models…
      </Card>
    );

  if (query.isError)
    return (
      <Card role="status" className="text-muted-foreground p-4 text-sm">
        Couldn&apos;t load the models for this agent.
      </Card>
    );

  const data = query.data;

  // No injectable key: say what is missing rather than showing a picker that
  // cannot pick anything. The switch list below this card is the fix.
  if (!data || data.provider === null)
    return (
      <Card className="gap-1.5 p-4">
        <p className="text-sm font-medium">No model key connected</p>
        <p className="text-muted-foreground text-sm">
          Give this agent access to an LLM key below, and it will run that
          provider&apos;s default model.
        </p>
      </Card>
    );

  const selectedModel =
    draftModel ?? (data.selected.overridden ? data.selected.model : DEFAULT);
  const selectedEffort = draftEffort ?? data.selected.effort ?? DEFAULT;
  // CHANGED, not merely touched. Picking B then picking A again must not leave
  // a Save armed: saving would respawn the container and stop whatever the
  // agent is doing, to write the values already stored.
  const storedModel = data.selected.overridden ? data.selected.model : DEFAULT;
  const storedEffort = data.selected.effort ?? DEFAULT;
  const dirty =
    selectedModel !== storedModel || selectedEffort !== storedEffort;

  const save = () => {
    update.mutate(
      {
        agentId,
        ...(draftModel !== null && {
          model: draftModel === DEFAULT ? null : draftModel,
        }),
        ...(draftEffort !== null && {
          effort: draftEffort === DEFAULT ? null : (draftEffort as AgentEffort),
        }),
      },
      {
        onSuccess: () => {
          setDraftModel(null);
          setDraftEffort(null);
        },
      },
    );
  };

  return (
    <Card className="gap-4 p-4">
      <div className="flex items-start gap-2">
        <Cpu
          className="text-muted-foreground mt-0.5 size-4 shrink-0"
          aria-hidden
        />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2">
            <p className="text-sm font-medium break-words">
              Running {data.selected.model}
            </p>
            {/* The same quiet confirmation an app connection gets (the brand
                dot, per connected-tab): the key is in and working, said once,
                in brand green — the subtitle below no longer repeats it. */}
            <p className="text-brand flex items-center gap-1.5 text-xs font-medium">
              <span className="bg-brand size-2 rounded-full" aria-hidden />
              {data.providerLabel} key connected
            </p>
          </div>
          <p className="text-muted-foreground text-sm">
            {data.selected.overridden
              ? "Your choice, on the key connected below."
              : "The default for this key. Change it here if you'd rather run something else."}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Label htmlFor={modelId}>Model</Label>
          <Select
            value={selectedModel}
            onValueChange={setDraftModel}
            disabled={update.isPending}
          >
            <SelectTrigger id={modelId} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT}>
                Default ({data.defaults.model})
              </SelectItem>
              {data.models.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {model.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {data.efforts.length > 0 && (
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Label htmlFor={effortId}>Thinking</Label>
            <Select
              value={selectedEffort}
              onValueChange={setDraftEffort}
              disabled={update.isPending}
            >
              <SelectTrigger id={effortId} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT}>Provider default</SelectItem>
                {data.efforts.map((effort) => (
                  <SelectItem key={effort.id} value={effort.id}>
                    {effort.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {dirty && (
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={save} disabled={update.isPending}>
            {update.isPending && (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            )}
            {update.isPending ? "Saving…" : "Save"}
          </Button>
          <p className="text-muted-foreground text-xs">
            The agent restarts to pick this up. Anything it is working on right
            now will stop.
          </p>
        </div>
      )}
    </Card>
  );
};
