"use client";

import { X } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@onecli/ui/components/select";
import { EVAL_HOST_PREFIX } from "@onecli/api/validations/evals";
import type { ExpectedAppOption } from "./expected-app-options";

/**
 * The apps a question requires: chips for the chosen ones, and a picker of
 * the apps this agent can use. Stored apps the agent can no longer use stay
 * as chips (marked) until removed, so nothing disappears silently.
 * Label, help and the field error belong to the surrounding `FormField`.
 */
export const ExpectedAppsField = ({
  id,
  describedBy,
  invalid,
  value,
  onChange,
  options,
  appLabel,
  state,
  onRetry,
  disabled,
}: {
  id: string;
  describedBy: string;
  invalid: boolean;
  value: string[];
  onChange: (apps: string[]) => void;
  options: ExpectedAppOption[];
  appLabel: (id: string) => string;
  state: "loading" | "error" | "ready";
  onRetry: () => void;
  disabled?: boolean;
}) => {
  const available = new Set(
    options.filter((o) => !o.unavailable).map((o) => o.id),
  );
  const choices = options.filter((o) => !value.includes(o.id));
  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <ul aria-label="Required apps" className="flex flex-wrap gap-1.5">
          {value.map((app) => (
            <li
              key={app}
              className="bg-muted inline-flex max-w-full items-center gap-1 rounded-md py-1 ps-2 pe-1 text-xs"
            >
              <span className="truncate">{appLabel(app)}</span>
              {state === "ready" && !available.has(app) && (
                <span className="text-muted-foreground shrink-0">
                  (not available to this agent)
                </span>
              )}
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                disabled={disabled}
                aria-label={`Remove ${appLabel(app)}`}
                onClick={() => onChange(value.filter((v) => v !== app))}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Select
        value=""
        onValueChange={(app) => onChange([...value, app])}
        disabled={disabled || state !== "ready" || choices.length === 0}
      >
        <SelectTrigger
          id={id}
          size="sm"
          className="w-full"
          aria-invalid={invalid}
          aria-describedby={describedBy}
        >
          <SelectValue
            placeholder={
              state === "loading"
                ? "Loading apps…"
                : choices.length === 0 && options.length > 0
                  ? "Every app is already required"
                  : "Add an app"
            }
          />
        </SelectTrigger>
        <SelectContent position="popper">
          {choices.map((option) => (
            <SelectItem
              key={option.id}
              value={option.id}
              disabled={!!option.unavailable}
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{option.label}</span>
                <span className="text-muted-foreground truncate text-xs">
                  {option.unavailable ??
                    (option.id.startsWith(EVAL_HOST_PREFIX)
                      ? option.id.slice(EVAL_HOST_PREFIX.length)
                      : "Connected app")}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {state === "error" ? (
        <p role="alert" className="text-destructive text-xs">
          Could not load this agent&apos;s apps. Chosen apps are kept.{" "}
          <Button
            type="button"
            variant="link"
            size="xs"
            className="h-auto px-0"
            onClick={onRetry}
          >
            Try again
          </Button>
        </p>
      ) : (
        state === "ready" &&
        options.length === 0 && (
          <p className="text-muted-foreground text-xs">
            This agent has no apps that can be checked yet.
          </p>
        )
      )}
    </div>
  );
};
