"use client";

import { toast } from "sonner";
import { Copy } from "lucide-react";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import {
  PATH_MODE_OPTIONS,
  pathPreview,
  type GenericInjection,
} from "./generic-injection";
import { SegmentedChoice } from "./segmented-choice";

export interface PathInjectionFieldsProps {
  value: GenericInjection;
  hostPattern: string;
  onChange: (patch: Partial<GenericInjection>) => void;
}

/** The URL-path injection editor (template or regex) with its live preview. */
export const PathInjectionFields = ({
  value,
  hostPattern,
  onChange,
}: PathInjectionFieldsProps) => {
  const { copy } = useCopyToClipboard();
  const preview = pathPreview(value);
  const isTemplate = value.pathMode === "template";

  const copyExampleCall = (path: string) => {
    const host = hostPattern.trim().replace(/^\*\./, "") || "api.example.com";
    void copy(`https://${host}${path}`).then((copied) => {
      if (copied) toast.success("Example call copied");
      else toast.error("Couldn't copy to clipboard");
    });
  };

  return (
    <div className="motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150 space-y-3">
      <div className="flex items-center gap-3">
        <Label
          id="path-mode-label"
          className="text-muted-foreground shrink-0 text-xs"
        >
          Mode
        </Label>
        <SegmentedChoice
          options={PATH_MODE_OPTIONS}
          value={value.pathMode}
          onValueChange={(pathMode) => onChange({ pathMode })}
          labelledBy="path-mode-label"
          className="w-40"
        />
      </div>

      {isTemplate ? (
        <div className="space-y-2">
          <Label htmlFor="secret-path-template">Path template</Label>
          <Input
            autoComplete="off"
            spellCheck={false}
            id="secret-path-template"
            className="font-mono"
            placeholder="/bot{value}"
            value={value.pathTemplate}
            onChange={(e) => onChange({ pathTemplate: e.target.value })}
          />
          <p className="text-muted-foreground text-xs">
            Put <code className="text-xs">{"{value}"}</code> where the key goes.
            The gateway replaces whatever your agent sends in that spot (up to
            the next <code className="text-xs">/</code>), so the agent never
            needs the real key.
          </p>
        </div>
      ) : (
        <>
          <div className="space-y-2">
            <Label htmlFor="secret-path-regex">Path pattern (regex)</Label>
            <Input
              autoComplete="off"
              spellCheck={false}
              id="secret-path-regex"
              className="font-mono"
              placeholder="^/bot[^/]+(/.*)?$"
              value={value.pathRegex}
              onChange={(e) => onChange({ pathRegex: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="secret-path-replacement">Replacement</Label>
            <Input
              autoComplete="off"
              spellCheck={false}
              id="secret-path-replacement"
              className="font-mono"
              placeholder="/bot{value}$1"
              value={value.pathReplacement}
              onChange={(e) => onChange({ pathReplacement: e.target.value })}
            />
            <p className="text-muted-foreground text-xs">
              Use <code className="text-xs">$1</code> for capture groups and{" "}
              <code className="text-xs">{"{value}"}</code> for the key.
            </p>
          </div>
        </>
      )}

      {preview && (
        <div className="bg-muted/40 space-y-1.5 rounded-md border p-3">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
              Preview
            </span>
            {isTemplate && (
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground flex items-center gap-1 rounded-sm text-[11px] transition-colors outline-none focus-visible:ring-ring/50 focus-visible:ring-[3px]"
                onClick={() => copyExampleCall(preview.before)}
              >
                <Copy aria-hidden className="size-3" />
                Copy call
              </button>
            )}
          </div>
          <div className="space-y-1 font-mono text-xs">
            <div className="flex gap-2">
              <span className="text-muted-foreground w-24 shrink-0">
                {isTemplate ? "Agent sends" : "Matches"}
              </span>
              <span className="break-all">{preview.before}</span>
            </div>
            <div className="flex gap-2">
              <span className="text-muted-foreground w-24 shrink-0">
                {isTemplate ? "Gateway sends" : "Rewrites to"}
              </span>
              <span className="text-foreground break-all">{preview.after}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
