import { Label } from "@onecli/ui/components/label";

/** The ARIA ids a field's control must reference: its help, then its error. */
export const fieldDescribedBy = (id: string, error?: string) =>
  `${id}-help${error ? ` ${id}-error` : ""}`;

/**
 * One labelled form field: label, the control (which must carry `id` and
 * `aria-describedby={fieldDescribedBy(id, error)}`), help, and an error
 * announced when it appears.
 */
export const FormField = ({
  id,
  label,
  help,
  error,
  children,
}: {
  id: string;
  label: string;
  help: React.ReactNode;
  error?: string;
  children: React.ReactNode;
}) => (
  <div className="space-y-1.5">
    <Label htmlFor={id}>{label}</Label>
    {children}
    <p id={`${id}-help`} className="text-muted-foreground text-xs">
      {help}
    </p>
    {error && (
      <p id={`${id}-error`} role="alert" className="text-destructive text-xs">
        {error}
      </p>
    )}
  </div>
);
