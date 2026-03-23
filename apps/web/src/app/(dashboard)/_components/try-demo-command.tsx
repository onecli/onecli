"use client";

import { Copy, Check } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

interface TryDemoCommandProps {
  command: string;
  highlight?: string;
}

export const TryDemoCommand = ({ command, highlight }: TryDemoCommandProps) => {
  const { copied, copy } = useCopyToClipboard();

  const renderCommand = () => {
    if (!highlight) return command;
    const idx = command.indexOf(highlight);
    if (idx === -1) return command;
    return (
      <>
        {command.slice(0, idx)}
        <span className="text-brand font-semibold">{highlight}</span>
        {command.slice(idx + highlight.length)}
      </>
    );
  };

  return (
    <div className="relative">
      <pre className="bg-muted rounded-md border p-3 pr-10 font-mono text-xs whitespace-pre-wrap break-all">
        {renderCommand()}
      </pre>
      <Button
        variant="ghost"
        size="icon"
        className="absolute top-1.5 right-1.5"
        onClick={() => copy(command)}
      >
        {copied ? (
          <Check className="size-4 text-brand" />
        ) : (
          <Copy className="size-4" />
        )}
      </Button>
    </div>
  );
};
