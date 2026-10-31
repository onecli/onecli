"use client";

import { useRef, useState } from "react";
import { FileCheck2, Upload, X } from "lucide-react";
import { Button } from "@onecli/ui/components/button";

/** Largest certificate file read; a CA bundle is a few hundred KB at most. */
const MAX_FILE_BYTES = 512 * 1024;

const PEM_MARKER = "-----BEGIN CERTIFICATE-----";

export interface CertificateUploadProps {
  id: string;
  name: string;
  describedBy?: string;
  value: string;
  onChange: (value: string) => void;
  accept: string;
  label: string;
}

/** Pick a certificate file instead of pasting it: its text becomes the
 *  value. Shows the chosen file's name, and a way to remove it. */
export const CertificateUpload = ({
  id,
  name,
  describedBy,
  value,
  onChange,
  accept,
  label,
}: CertificateUploadProps) => {
  const input = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pick = (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (file.size > MAX_FILE_BYTES) {
      setError("That file is too large to be a certificate.");
      return;
    }
    file
      .text()
      .then((text) => {
        if (!text.includes(PEM_MARKER)) {
          setError(`Choose a PEM certificate (it starts with ${PEM_MARKER}).`);
          return;
        }
        setFileName(file.name);
        onChange(text.trim());
      })
      .catch(() => setError("That file could not be read."));
  };
  return (
    <div className="grid gap-1.5">
      <input
        ref={input}
        id={id}
        name={name}
        type="file"
        accept={accept}
        aria-describedby={describedBy}
        className="sr-only"
        onChange={(e) => {
          pick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {value ? (
        <div className="flex min-h-11 items-center justify-between gap-2 rounded-md border px-3 text-sm">
          <span className="flex min-w-0 items-center gap-2">
            <FileCheck2
              className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
              aria-hidden="true"
            />
            <span className="truncate">{fileName ?? "Certificate added"}</span>
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Remove certificate"
            onClick={() => {
              setFileName(null);
              onChange("");
            }}
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          className="min-h-11 w-full"
          onClick={() => input.current?.click()}
        >
          <Upload className="size-4" aria-hidden="true" />
          {label}
        </Button>
      )}
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </div>
  );
};
