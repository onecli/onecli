"use client";

import { TriangleAlert } from "lucide-react";
import type { ConnectFormField } from "@onecli/api/apps/types";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@onecli/ui/components/select";
import { SecretInput } from "@/components/secret-input";
import { CertificateUpload } from "./certificate-upload";

interface FieldInputProps {
  field: ConnectFormField;
  value: string;
  onChange: (value: string) => void;
  connectionType: string;
  autoFocus?: boolean;
}
export const FieldInput = ({
  field,
  value,
  onChange,
  connectionType,
  autoFocus,
}: FieldInputProps) => {
  const id = `connect-${field.name}`;
  const warning = field.options?.find((o) => o.value === value)?.warning;
  const warningId = warning ? `${id}-warning` : undefined;
  const helpId = field.description || field.helpUrl ? `${id}-help` : undefined;
  const describedBy =
    [helpId, warningId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>
        {field.label}
        {!field.optional && <span className="text-destructive ml-0.5">*</span>}
      </Label>
      {helpId && (
        <p
          id={helpId}
          className="text-xs leading-relaxed text-muted-foreground dark:text-foreground/70 text-pretty"
        >
          {field.description}
          {field.description && field.helpUrl && " "}
          {field.helpUrl && (
            <a
              href={field.helpUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="whitespace-nowrap underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:text-foreground hover:decoration-foreground/60"
            >
              {field.helpLabel ?? "Learn more"}
            </a>
          )}
        </p>
      )}
      {field.options ? (
        <Select
          value={value || undefined}
          onValueChange={onChange}
          name={field.name}
        >
          <SelectTrigger
            id={id}
            aria-describedby={describedBy}
            aria-required={!field.optional}
            className="min-h-11 w-full text-sm"
            autoFocus={autoFocus}
          >
            <SelectValue placeholder={field.placeholder} />
          </SelectTrigger>
          <SelectContent>
            {field.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : field.fileUpload ? (
        <CertificateUpload
          id={id}
          name={field.name}
          describedBy={describedBy}
          value={value}
          onChange={onChange}
          accept={field.fileUpload.accept}
          label={field.fileUpload.label}
        />
      ) : field.secret === true ||
        (field.secret === undefined && connectionType === "api_key") ? (
        <SecretInput
          id={id}
          name={field.name}
          aria-describedby={describedBy}
          aria-required={!field.optional}
          className="min-h-11"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          autoFocus={autoFocus}
        />
      ) : (
        <Input
          id={id}
          name={field.name}
          aria-describedby={describedBy}
          aria-required={!field.optional}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          className="min-h-11 font-mono text-sm"
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
        />
      )}
      {warning && (
        <p
          id={warningId}
          role="note"
          className="flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-50 px-2.5 py-2 text-xs leading-relaxed text-amber-800 dark:bg-amber-500/10 dark:text-amber-300"
        >
          <TriangleAlert
            className="mt-0.5 size-3.5 shrink-0"
            aria-hidden="true"
          />
          <span>{warning}</span>
        </p>
      )}
    </div>
  );
};
