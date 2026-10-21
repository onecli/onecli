"use client";

import { cn } from "@onecli/ui/lib/utils";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import {
  DEFAULT_HEADER_NAME,
  DEFAULT_PARAM_NAME,
  SENT_AS_OPTIONS,
  formatError,
  sentAsPreview,
  type GenericInjection,
} from "./generic-injection";
import { OptionalField } from "./optional-field";
import { PathInjectionFields } from "./path-injection-fields";
import { SegmentedChoice } from "./segmented-choice";

export interface SentAsFieldsProps {
  value: GenericInjection;
  hostPattern: string;
  onChange: (patch: Partial<GenericInjection>) => void;
}

/** "Sent as": how a custom connection's key reaches the API. */
export const SentAsFields = ({
  value,
  hostPattern,
  onChange,
}: SentAsFieldsProps) => {
  const { sentAs } = value;
  const isHeader = sentAs === "header";
  const preview = sentAsPreview(value);
  const invalidFormat = formatError(value);

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label id="sent-as-label">Sent as</Label>
        <SegmentedChoice
          options={SENT_AS_OPTIONS}
          value={sentAs}
          onValueChange={(next) => onChange({ sentAs: next })}
          labelledBy="sent-as-label"
          className="w-full"
        />
      </div>

      {(sentAs === "header" || sentAs === "param") && (
        <div
          key={sentAs}
          className="motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150 space-y-3"
        >
          <div className="space-y-2">
            <Label htmlFor={isHeader ? "secret-header" : "secret-param"}>
              {isHeader ? "Header name" : "Parameter name"}
            </Label>
            <Input
              autoComplete="off"
              spellCheck={false}
              id={isHeader ? "secret-header" : "secret-param"}
              placeholder={isHeader ? DEFAULT_HEADER_NAME : DEFAULT_PARAM_NAME}
              value={isHeader ? value.headerName : value.paramName}
              onChange={(e) =>
                onChange(
                  isHeader
                    ? { headerName: e.target.value }
                    : { paramName: e.target.value },
                )
              }
            />
          </div>
          <OptionalField
            label="Value format"
            open={value.formatOpen}
            onOpenChange={(formatOpen) => onChange({ formatOpen })}
          >
            <Label htmlFor="secret-format" className="sr-only">
              Value format
            </Label>
            <Input
              autoComplete="off"
              spellCheck={false}
              id="secret-format"
              className={cn("font-mono", invalidFormat && "border-destructive")}
              placeholder="Token {value}"
              value={value.format}
              aria-invalid={!!invalidFormat}
              aria-describedby="secret-format-hint"
              onChange={(e) => onChange({ format: e.target.value })}
            />
            <p
              id="secret-format-hint"
              className={cn(
                "text-xs",
                invalidFormat ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {invalidFormat ?? (
                <>
                  For APIs that want text around the key. Put{" "}
                  <code className="text-xs">{"{value}"}</code> where the key
                  goes.
                </>
              )}
            </p>
          </OptionalField>
        </div>
      )}

      {sentAs === "path" ? (
        <PathInjectionFields
          value={value}
          hostPattern={hostPattern}
          onChange={onChange}
        />
      ) : (
        preview && (
          <p
            data-testid="sent-as-preview"
            className="bg-muted/40 text-muted-foreground rounded-md border px-3 py-2 font-mono text-xs break-all"
          >
            {preview}
          </p>
        )
      )}
    </div>
  );
};
