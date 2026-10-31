"use client";

import { useRef } from "react";
import { Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import { useImportSkillZip } from "@/hooks/use-skills";
import type { SkillImportResult } from "@/lib/api";
import { writeErrorToast } from "@/lib/api/write-error-toast";

export interface ImportSkillZipButtonProps {
  /** The agent to import into; omitted = the organization tier. */
  agentId?: string;
}

/** A finished import, said plainly: what was added, and what was left out
 * and why (the first reason, with a count of the rest). */
const importSummary = ({ imported, problems }: SkillImportResult) => {
  const leftOut = [
    ...problems.map((p) => `${p.folder || "The zip"}: ${p.reason}`),
    ...imported.flatMap((s) =>
      s.skipped.map((f) => `${s.name}/${f.path}: ${f.reason}`),
    ),
  ];
  const first = leftOut[0];
  return {
    title: `Added ${imported.map((s) => s.name).join(", ")}`,
    description:
      first === undefined
        ? undefined
        : leftOut.length === 1
          ? `Left out ${first}`
          : `Left out ${leftOut.length} items, like ${first}`,
  };
};

/**
 * Upload a skill zip (the format Claude and other agents use): every
 * folder, file and runnable script is kept. One zip may hold several
 * skills; a name that already exists is replaced.
 */
export const ImportSkillZipButton = ({
  agentId,
}: ImportSkillZipButtonProps) => {
  const input = useRef<HTMLInputElement>(null);
  const importZip = useImportSkillZip();

  const onFile = (file: File | undefined) => {
    if (!file) return;
    importZip.mutate(
      { file, agentId },
      {
        onSuccess: (result) => {
          const { title, description } = importSummary(result);
          toast.success(title, { description });
        },
        // The server's reason, read long enough to act on.
        onError: (error) =>
          writeErrorToast(`Couldn't import ${file.name}`, error, {
            retry: () => onFile(file),
          }),
      },
    );
  };

  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        // The visible button opens it; the input itself is never a stop.
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          onFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={importZip.isPending}
        onClick={() => input.current?.click()}
      >
        {importZip.isPending ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Upload className="size-4" />
        )}
        {importZip.isPending ? "Uploading…" : "Upload a zip"}
      </Button>
    </>
  );
};
