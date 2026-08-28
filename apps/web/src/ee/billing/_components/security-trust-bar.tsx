import { Shield, Lock, ShieldCheck } from "lucide-react";

const BADGES = [
  { icon: Shield, label: "End-to-End Encryption" },
  { icon: Lock, label: "Policy Enforcement" },
  { icon: ShieldCheck, label: "Audit Logging" },
] as const;

export const SecurityTrustBar = () => (
  <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
    {BADGES.map(({ icon: Icon, label }) => (
      <div
        key={label}
        className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium"
      >
        <Icon className="size-3.5" />
        {label}
      </div>
    ))}
  </div>
);
