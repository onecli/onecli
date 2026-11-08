"use client";

import { Check, Copy } from "lucide-react";
import {
  SKILL_FINGERPRINT_PATTERN,
  skillCheckCommand,
} from "@onecli/api/lib/skill-import-rules";
import { Button } from "@onecli/ui/components/button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

export interface SkillFingerprintProps {
  /** The imported skill's sha256; anything else renders nothing. */
  fingerprint: string;
  /** The skill it belongs to, where more than one is listed. */
  name?: string;
}

/**
 * An imported skill's fingerprint, short, and the terminal check that
 * recomputes it on the source folder, one click away. The copy confirms in
 * place with where to run it (a status, so it is announced): a tooltip
 * would sit under the toast this also renders in.
 */
export const SkillFingerprint = ({
  fingerprint,
  name,
}: SkillFingerprintProps) => {
  const { copied, copy } = useCopyToClipboard(4000);
  if (!SKILL_FINGERPRINT_PATTERN.test(fingerprint)) return null;
  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 text-xs">
      <span
        className="font-mono"
        title={`sha256 ${fingerprint}`}
        translate="no"
      >
        {name && <span className="font-sans font-medium">{name} </span>}
        sha256 {fingerprint.slice(0, 12)}
      </span>
      <Button
        variant="ghost"
        size="xs"
        onClick={() => void copy(skillCheckCommand(fingerprint))}
        aria-label={`Copy check command${name ? ` for ${name}` : ""}`}
      >
        {copied ? (
          <Check className="text-brand size-3.5" aria-hidden />
        ) : (
          <Copy className="size-3.5" aria-hidden />
        )}
        {copied ? "Copied" : "Copy check command"}
      </Button>
      <span role="status">
        {copied && "Run it in a terminal inside the skill's source folder."}
      </span>
    </div>
  );
};
