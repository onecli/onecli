"use client";

import { Label } from "@onecli/ui/components/label";
import { Checkbox } from "@onecli/ui/components/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@onecli/ui/components/select";
import { cn } from "@onecli/ui/lib/utils";
import type { Secret } from "@/lib/api";

/** The Secret target's editable state — the mirror of `AppTargetState`. A rule's
 * Secret target is authored one of two ways: `specific` secrets (→ `secret`
 * targets by id) or `all` secrets at a level (→ a `secret` target with a
 * `secretScope`). */
export interface SecretTargetState {
  mode: "specific" | "all";
  secretIds: string[];
  /** Only meaningful for `mode === "all"`; the org/project level to inject. */
  level: "organization" | "project";
}

export interface SecretTargetFieldsProps {
  value: SecretTargetState;
  onChange: (next: SecretTargetState) => void;
  /** Secrets available at the rule's scope. */
  secrets: Secret[];
  /** An ORG rule may choose the injection level (org or project); a PROJECT rule
   * is fixed to its own project. */
  isOrgRule: boolean;
  showError: boolean;
  error: string | null;
}

/**
 * The Secret target authoring surface: target either specific secret(s), or "all
 * secrets" at a chosen level (an org rule can reach down to project-level secrets;
 * a project rule is project-only). On an allow rule the target permits those
 * secrets' hosts and injects them; on a block rule it blocks them. Mirrors
 * {@link AppTargetFields}.
 */
export const SecretTargetFields = ({
  value,
  onChange,
  secrets,
  isOrgRule,
  showError,
  error,
}: SecretTargetFieldsProps) => {
  const toggleSecret = (id: string, checked: boolean) => {
    const next = checked
      ? [...value.secretIds, id]
      : value.secretIds.filter((s) => s !== id);
    onChange({ ...value, secretIds: next });
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="rule-secret-mode">Secrets</Label>
        <Select
          value={value.mode}
          onValueChange={(mode) =>
            onChange({ ...value, mode: mode === "all" ? "all" : "specific" })
          }
        >
          <SelectTrigger id="rule-secret-mode" className="w-full bg-card">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="specific">Specific secret(s)</SelectItem>
            <SelectItem value="all">All secrets</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {value.mode === "specific" ? (
        <fieldset className="space-y-2 rounded-lg border bg-card p-3">
          <legend className="px-1 text-xs text-muted-foreground">
            These secrets
          </legend>
          {secrets.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No secrets available in this scope.
            </p>
          ) : (
            secrets.map((s) => {
              const id = `secret-${s.id}`;
              return (
                <div key={s.id} className="flex items-center gap-2">
                  <Checkbox
                    id={id}
                    checked={value.secretIds.includes(s.id)}
                    onCheckedChange={(checked) =>
                      toggleSecret(s.id, checked === true)
                    }
                  />
                  <Label htmlFor={id} className="font-normal">
                    {s.name}
                    <span className="text-muted-foreground">
                      {" · "}
                      {s.typeLabel}
                    </span>
                  </Label>
                </div>
              );
            })
          )}
        </fieldset>
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor="rule-secret-level">At level</Label>
          {isOrgRule ? (
            <Select
              value={value.level}
              onValueChange={(level) =>
                onChange({
                  ...value,
                  level: level === "organization" ? "organization" : "project",
                })
              }
            >
              <SelectTrigger id="rule-secret-level" className="w-full bg-card">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="organization">
                  All organization secrets
                </SelectItem>
                <SelectItem value="project">
                  All of the project&apos;s custom secrets
                </SelectItem>
              </SelectContent>
            </Select>
          ) : (
            <p className="text-xs text-muted-foreground">
              All of this project&apos;s custom secrets.
            </p>
          )}
        </div>
      )}

      {showError && error && (
        <p className={cn("text-xs text-destructive")} role="alert">
          {error}
        </p>
      )}
    </div>
  );
};
