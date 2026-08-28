"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@onecli/ui/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { Switch } from "@onecli/ui/components/switch";
import { usePlanGate } from "@/lib/plan-gate";
import type {
  AppAvailabilityConfig,
  AvailabilityRule,
} from "@/ee/app-availability/api";
import {
  useAppAvailability,
  useSetAppAvailability,
} from "../use-app-availability";
import { RuleList } from "./rule-list";
import type { RuleDraft } from "./rule-card";

const toDrafts = (rules: AvailabilityRule[]): RuleDraft[] =>
  rules.map((r) => ({
    key: r.id ?? crypto.randomUUID(),
    id: r.id,
    name: r.name ?? "",
    userIds: [...r.userIds],
    groupIds: [...r.groupIds],
    providers: [...r.providers],
  }));

/** Order-independent signature of the edit state, over only the rules that would
 *  actually persist (a rule with no people or no apps is a no-op, dropped on
 *  save — so it doesn't count toward "dirty"). */
const signature = (mode: string, rules: RuleDraft[]) =>
  JSON.stringify({
    mode,
    rules: rules
      .filter(
        (r) =>
          (r.userIds.length > 0 || r.groupIds.length > 0) &&
          r.providers.length > 0,
      )
      .map((r) =>
        JSON.stringify({
          name: r.name.trim(),
          u: [...r.userIds].sort(),
          g: [...r.groupIds].sort(),
          p: [...r.providers].sort(),
        }),
      )
      .sort(),
  });

export const AppAvailabilityEditor = () => {
  const planGate = usePlanGate();
  const locked = planGate.isLocked("groups");
  const { data, isError } = useAppAvailability(!locked);
  const setMutation = useSetAppAvailability();

  const [mode, setMode] = useState<"open" | "restricted">("open");
  const [rules, setRules] = useState<RuleDraft[]>([]);
  const [baseline, setBaseline] = useState(() => signature("open", []));
  const [seeded, setSeeded] = useState(false);
  const seededRef = useRef(false);

  const seed = (cfg: AppAvailabilityConfig) => {
    const drafts = toDrafts(cfg.rules);
    setMode(cfg.mode);
    setRules(drafts);
    setBaseline(signature(cfg.mode, drafts));
  };

  // Seed once from the loaded config; a background refetch must not clobber
  // in-progress edits (the ref guard), so post-save we re-seed manually.
  useEffect(() => {
    if (!seededRef.current && data) {
      seed(data);
      seededRef.current = true;
      setSeeded(true);
    }
  }, [data]);

  const disabled = setMutation.isPending;
  const dirty = signature(mode, rules) !== baseline;

  const handleSave = () => {
    const config: AppAvailabilityConfig = {
      mode,
      // Send every draft; the API drops no-op rules (and thereby deletes a rule
      // edited down to no people or no apps).
      rules: rules.map((r) => ({
        id: r.id,
        name: r.name.trim() || null,
        userIds: r.userIds,
        groupIds: r.groupIds,
        providers: r.providers,
      })),
    };
    // `mutate` (not `mutateAsync`) — the hook's onError toasts; re-seed from the
    // server echo only on success (the edit buffer survives a failed save).
    setMutation.mutate(config, { onSuccess: (saved) => seed(saved) });
  };

  if (locked) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">App availability</CardTitle>
          <CardDescription>
            Restrict which apps each workspace may connect based on who has
            access to it. This is an Enterprise feature.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button type="button" onClick={() => planGate.guard("groups")}>
            Upgrade to Enterprise
          </Button>
        </CardContent>
      </Card>
    );
  }

  // Only block on the INITIAL load failure; once seeded, ignore a transient
  // background-refetch error rather than replace the admin's live edits with it.
  if (isError && !seeded) {
    return (
      <p className="text-destructive text-sm">
        Failed to load app availability.
      </p>
    );
  }

  if (!seeded) {
    return <div className="bg-muted/40 h-40 animate-pulse rounded-lg border" />;
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Restrict app availability</CardTitle>
          <CardDescription>
            When on, a workspace can only connect apps granted by a rule that
            names one of the people who have access to it. When off, every app
            is available to every workspace.
          </CardDescription>
          <CardAction>
            <Switch
              checked={mode === "restricted"}
              onCheckedChange={(v) => setMode(v ? "restricted" : "open")}
              disabled={disabled}
              aria-label="Restrict app availability"
            />
          </CardAction>
        </CardHeader>
        {mode === "restricted" && (
          <CardContent>
            <RuleList rules={rules} onChange={setRules} disabled={disabled} />
          </CardContent>
        )}
      </Card>

      <div className="flex justify-end">
        <Button
          onClick={handleSave}
          loading={setMutation.isPending}
          disabled={!dirty || setMutation.isPending}
        >
          Save changes
        </Button>
      </div>
    </div>
  );
};
