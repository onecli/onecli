import { cn } from "@onecli/ui/lib/utils";

export interface OrDividerProps extends React.ComponentProps<"div"> {
  /** The word between the two rules, e.g. "or" or "or fill manually". */
  label: string;
}

/** A labelled horizontal rule separating alternative ways to connect. */
export const OrDivider = ({ label, className, ...props }: OrDividerProps) => (
  <div className={cn("flex items-center gap-3", className)} {...props}>
    <div className="bg-border h-px flex-1" />
    <span className="text-muted-foreground/60 text-[10px] uppercase tracking-widest">
      {label}
    </span>
    <div className="bg-border h-px flex-1" />
  </div>
);
