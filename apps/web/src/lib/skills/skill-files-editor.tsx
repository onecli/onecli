"use client";

import { Plus, Trash2 } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Textarea } from "@onecli/ui/components/textarea";
import type { SkillFileInput } from "@/lib/api";

/**
 * The extra-files editor: small path+content rows. Client-side mirror of the
 * wire shape (relative, ≤2 lowercase segments) so a traversal-shaped path
 * fails here with words instead of a 422 — the server stays the validator.
 */

export const MAX_SKILL_FILES = 5;

const FILE_PATH_RE = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?$/;

/**
 * One row's problem, or null. Content is checked HERE rather than filtered
 * away at submit: dropping a path-only row would silently delete an existing
 * file — and the prune carries that deletion into every running sandbox.
 */
export const skillFileProblem = (file: SkillFileInput): string | null => {
  const path = file.path.trim();
  if (path === "" && file.content.trim() === "") return null; // blank row
  if (path === "") return "Give this file a path, or remove it";
  if (!FILE_PATH_RE.test(path)) {
    return "Relative, at most two lowercase segments, like references/api.md";
  }
  if (path.toLowerCase() === "skill.md") {
    return "SKILL.md is generated from the fields above, so pick another path";
  }
  if (file.content.trim() === "") return "Add content, or remove this file";
  return null;
};

export interface SkillFilesEditorProps {
  files: SkillFileInput[];
  onChange: (files: SkillFileInput[]) => void;
  disabled?: boolean;
}

export const SkillFilesEditor = ({
  files,
  onChange,
  disabled,
}: SkillFilesEditorProps) => {
  const setFile = (index: number, patch: Partial<SkillFileInput>) => {
    onChange(
      files.map((file, i) => (i === index ? { ...file, ...patch } : file)),
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        {/* A group heading, not a control label — a <label> here would point
            at nothing. */}
        <p className="text-sm font-medium">Extra files (optional)</p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || files.length >= MAX_SKILL_FILES}
          onClick={() => onChange([...files, { path: "", content: "" }])}
        >
          <Plus className="size-4" />
          {files.length >= MAX_SKILL_FILES
            ? `Up to ${MAX_SKILL_FILES} files`
            : "Add file"}
        </Button>
      </div>
      {files.map((file, index) => {
        const problem = skillFileProblem(file);
        return (
          // Index keys are honest here only because a removal re-renders every
          // row from `files`; the caret/focus jump that causes is the known
          // trade for not threading a client id through the API shape.
          <div key={index} className="space-y-1.5 rounded-md border p-3">
            <div className="flex items-center gap-2">
              <Input
                value={file.path}
                onChange={(event) =>
                  setFile(index, { path: event.target.value })
                }
                placeholder="references/api.md"
                className="font-mono"
                maxLength={128}
                spellCheck={false}
                autoComplete="off"
                disabled={disabled}
                aria-label={`File ${index + 1} path`}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={disabled}
                aria-label={`Remove file ${index + 1}`}
                onClick={() => onChange(files.filter((_, i) => i !== index))}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
            {problem && <p className="text-destructive text-xs">{problem}</p>}
            <Textarea
              value={file.content}
              onChange={(event) =>
                setFile(index, { content: event.target.value })
              }
              placeholder="File content"
              rows={4}
              maxLength={24_000}
              disabled={disabled}
              aria-label={`File ${index + 1} content`}
            />
          </div>
        );
      })}
    </div>
  );
};
