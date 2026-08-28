"use client";

import Link from "next/link";
import { generateOrgPrefix } from "@/lib/org-navigation";
import { usePlanUsage } from "../use-plan-usage";

export const AgentsQuotaWarning = () => {
  const usage = usePlanUsage();
  const orgPrefix = generateOrgPrefix(usage?.organizationId);

  const agents = usage?.resources.find((r) => r.name === "Agents");
  if (!agents || agents.limit === Infinity || agents.limit === 0) return null;

  // Agent caps are small (3 on Pro), so a ratio threshold would only fire at
  // the cap itself — warn one agent early instead. Tiny caps (free's 2) only
  // warn at the cap, so a free org with its first agent isn't nagged forever.
  const remaining = agents.limit - agents.current;
  if (remaining > 1 || (remaining === 1 && agents.limit < 3)) return null;

  // Grandfathered paid orgs may sit above the new hard cap — like the
  // over-quota banner, don't nag paying customers about an accepted state
  // (creation is already blocked). Free orgs (e.g. after a downgrade) still
  // get flagged.
  if (agents.current > agents.limit && usage?.plan !== "free") return null;

  const isExceeded = agents.current > agents.limit;
  const atLimit = agents.current >= agents.limit;
  const percentage = Math.min(
    Math.round((agents.current / agents.limit) * 100),
    100,
  );

  return (
    <Link
      href={`${orgPrefix}/billing`}
      className="group hover:bg-accent/50 flex flex-col gap-1.5 rounded-md border px-3 py-2 transition-colors"
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">Agents</span>
        <span className="text-muted-foreground text-[10px] tabular-nums">
          {agents.current.toLocaleString()}/{agents.limit.toLocaleString()}
        </span>
      </div>
      <div className="bg-muted h-1 overflow-hidden rounded-full">
        <div
          className={`h-full rounded-full transition-all ${
            isExceeded ? "bg-destructive" : "bg-amber-500"
          }`}
          style={{ width: `${percentage}%` }}
        />
      </div>
      <span
        className={`text-[10px] transition-colors ${
          isExceeded
            ? "text-destructive/70 group-hover:text-destructive"
            : "text-muted-foreground group-hover:text-foreground"
        }`}
      >
        {atLimit ? "Upgrade for more agents" : "1 agent slot left"}
      </span>
    </Link>
  );
};
