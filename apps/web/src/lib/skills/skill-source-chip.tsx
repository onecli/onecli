import { cn } from "@onecli/ui/lib/utils";

export type SkillSourceKind = "agent" | "organization" | "library";

const LABELS: Record<SkillSourceKind, string> = {
  agent: "This agent",
  organization: "Organization",
  library: "GitHub library",
};

// Plain colored text, not a chip (the Schedules "When" style): one color per
// source, so a mixed list reads at a glance (green = yours, orange = org,
// indigo = the connected repo). Dark-mode pairs keep contrast.
const TONES: Record<SkillSourceKind, string> = {
  agent: "text-emerald-700 dark:text-emerald-400",
  organization: "text-orange-700 dark:text-orange-400",
  library: "text-indigo-700 dark:text-indigo-400",
};

export interface SkillSourceChipProps extends React.ComponentProps<"span"> {
  kind: SkillSourceKind;
}

export const SkillSourceChip = ({
  kind,
  className,
  ...props
}: SkillSourceChipProps) => (
  <span
    className={cn("shrink-0 text-xs font-medium", TONES[kind], className)}
    {...props}
  >
    {LABELS[kind]}
  </span>
);
