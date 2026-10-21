import { Badge } from "@onecli/ui/components/badge";
import { cn } from "@onecli/ui/lib/utils";

export type SkillSourceKind = "agent" | "organization" | "library";

const LABELS: Record<SkillSourceKind, string> = {
  agent: "This agent",
  organization: "Organization",
  library: "GitHub library",
};

// One color per source, so a mixed list reads at a glance (green = yours,
// orange = org, indigo = the connected repo). Dark-mode pairs keep contrast.
const TONES: Record<SkillSourceKind, string> = {
  agent:
    "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300",
  organization:
    "border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-900 dark:bg-orange-950 dark:text-orange-300",
  library:
    "border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-300",
};

export interface SkillSourceChipProps extends React.ComponentProps<"span"> {
  kind: SkillSourceKind;
}

export const SkillSourceChip = ({
  kind,
  className,
  ...props
}: SkillSourceChipProps) => (
  <Badge
    variant="outline"
    className={cn("font-medium", TONES[kind], className)}
    {...props}
  >
    {LABELS[kind]}
  </Badge>
);
