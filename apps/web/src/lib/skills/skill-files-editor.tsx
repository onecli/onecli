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

/** What is wrong with one row, and which of its two inputs it is about, so a
 *  blocked save can put the caret on the right one. */
export interface SkillFileProblem {
  field: "path" | "content";
  message: string;
}

/**
 * One row's problem, or null. Content is checked HERE rather than filtered
 * away at submit: dropping a path-only row would silently delete an existing
 * file — and the prune carries that deletion into every running sandbox.
 */
export const skillFileProblem = (
  file: SkillFileInput,
): SkillFileProblem | null => {
  const path = file.path.trim();
  if (path === "" && file.content.trim() === "") return null; // blank row
  if (path === "") {
    return { field: "path", message: "Give this file a path, or remove it" };
  }
  if (!FILE_PATH_RE.test(path)) {
    return {
      field: "path",
      message:
        "Relative, at most two lowercase segments, like references/api.md",
    };
  }
  if (path.toLowerCase() === "skill.md") {
    return {
      field: "path",
      message:
        "SKILL.md is generated from the fields above, so pick another path",
    };
  }
  if (file.content.trim() === "") {
    return { field: "content", message: "Add content, or remove this file" };
  }
  return null;
};

/** The DOM id of one row's input (or its problem line): the dialog focuses
 *  the input when a save is blocked by that row. Fixed ids like the dialog's
 *  own (`skill-name`): only one skill dialog is ever open, so none collide. */
export const skillFileElementId = (
  index: number,
  field: SkillFileProblem["field"] | "problem",
) => `skill-file-${index + 1}-${field}`;

const LOCK_HINT_ID = "skill-files-lock-hint";

export interface SkillFilesEditorProps {
  files: SkillFileInput[];
  onChange: (files: SkillFileInput[]) => void;
  disabled?: boolean;
  /**
   * Whether the SKILL.md body has been written yet. Extra files are
   * REFERENCES the agent may open, meaningless without the body that tells it
   * to, so the door stays shut until the body exists. Observed failure: a user
   * pasted a whole skill into an extra file, left the body empty, and hit a
   * dead Create button.
   */
  hasBody?: boolean;
  /** A save was attempted: mark the input each row's problem is about. */
  showErrors?: boolean;
}

export const SkillFilesEditor = ({
  files,
  onChange,
  disabled,
  hasBody = true,
  showErrors = false,
}: SkillFilesEditorProps) => {
  const setFile = (index: number, patch: Partial<SkillFileInput>) => {
    onChange(
      files.map((file, i) => (i === index ? { ...file, ...patch } : file)),
    );
  };

  // Only the FIRST file waits for the body: once a file exists, clearing the
  // body must not trap the rows the user already has.
  const locked = !hasBody && files.length === 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* A group heading, not a control label — a <label> here would point
            at nothing. */}
        <p className="text-sm font-medium">Extra files (optional)</p>
        <div className="flex items-center gap-2">
          {/* Visible text, not a `title`: a disabled Button takes no pointer
              events, so its tooltip never shows (and keyboard and touch never
              reach it), which would leave a dead button with no reason. */}
          {locked && (
            <span id={LOCK_HINT_ID} className="text-muted-foreground text-xs">
              Write the instructions first
            </span>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled || locked || files.length >= MAX_SKILL_FILES}
            aria-describedby={locked ? LOCK_HINT_ID : undefined}
            onClick={() => onChange([...files, { path: "", content: "" }])}
          >
            <Plus className="size-4" />
            {files.length >= MAX_SKILL_FILES
              ? `Up to ${MAX_SKILL_FILES} files`
              : "Add file"}
          </Button>
        </div>
      </div>
      {files.map((file, index) => {
        const problem = skillFileProblem(file);
        const problemId = skillFileElementId(index, "problem");
        return (
          // Index keys are honest here only because a removal re-renders every
          // row from `files`; the caret/focus jump that causes is the known
          // trade for not threading a client id through the API shape.
          <div key={index} className="space-y-1.5 rounded-md border p-3">
            <div className="flex items-center gap-2">
              <Input
                id={skillFileElementId(index, "path")}
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
                aria-invalid={showErrors && problem?.field === "path"}
                aria-describedby={
                  problem?.field === "path" ? problemId : undefined
                }
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
            {problem && (
              <p id={problemId} className="text-destructive text-xs">
                {problem.message}
              </p>
            )}
            <Textarea
              id={skillFileElementId(index, "content")}
              value={file.content}
              onChange={(event) =>
                setFile(index, { content: event.target.value })
              }
              placeholder="File content"
              rows={4}
              maxLength={24_000}
              disabled={disabled}
              aria-label={`File ${index + 1} content`}
              aria-invalid={showErrors && problem?.field === "content"}
              aria-describedby={
                problem?.field === "content" ? problemId : undefined
              }
            />
          </div>
        );
      })}
    </div>
  );
};
