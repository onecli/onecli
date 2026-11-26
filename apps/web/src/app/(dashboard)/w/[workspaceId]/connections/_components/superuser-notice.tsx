import { TriangleAlert } from "lucide-react";
import { cn } from "@onecli/ui/lib/utils";

/** Shared warning for database roles with server-level privileges. */
export const SuperuserNotice = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    role="note"
    aria-label="Elevated database access"
    className={cn(
      "flex items-start gap-2 rounded-md bg-amber-500/5 px-3 py-2.5 text-xs leading-relaxed",
      className,
    )}
    {...props}
  >
    <TriangleAlert
      className="mt-0.5 size-3.5 shrink-0 text-amber-700 dark:text-amber-400"
      aria-hidden="true"
    />
    <div className="min-w-0 space-y-0.5">
      <p className="font-medium text-amber-800 dark:text-amber-300">
        Elevated database access
      </p>
      <p className="text-muted-foreground dark:text-foreground/70">
        This role can access server files or run programs. Use a restricted role
        for agents.
      </p>
    </div>
  </div>
);
