"use client";

import { useEffect, useState } from "react";
import { cn } from "@onecli/ui/lib/utils";
import { prefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { ChatMarkdown } from "./chat-markdown";

/** How long a folding note takes to collapse. Matches the class below. */
const FOLD_MS = 300;

/**
 * A draft that turned out to be narration, folding away. The agent wrote a
 * sentence ("Now the config."), then started a tool: those words were
 * progress, not the answer, and they move into the work timeline. Rather
 * than vanishing between two frames, they collapse upward and fade, so the
 * reader sees where they went.
 *
 * Mounted once per fold (keyed by the step), it plays and removes itself.
 * Under reduced motion it is never shown at all.
 *
 * SECURITY: the text is untrusted model output, rendered only through
 * ChatMarkdown, exactly as it was on screen a moment before.
 */
export const FoldingNote = ({ text }: { text: string }) => {
  const [phase, setPhase] = useState<"open" | "closing" | "gone">("open");

  useEffect(() => {
    if (prefersReducedMotion()) {
      setPhase("gone");
      return;
    }
    // One frame open, then collapse: the transition needs a start state.
    const frame = requestAnimationFrame(() => setPhase("closing"));
    // transitionend can be skipped (a hidden tab): never leave it mounted.
    const timer = setTimeout(() => setPhase("gone"), FOLD_MS + 100);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, []);

  if (phase === "gone") return null;
  return (
    <div
      aria-hidden
      data-slot="folding-note"
      onTransitionEnd={() => setPhase("gone")}
      className={cn(
        "grid transition-[grid-template-rows,opacity,translate] duration-300 ease-out",
        phase === "open"
          ? "grid-rows-[1fr] opacity-100"
          : "-translate-y-1 grid-rows-[0fr] opacity-0",
      )}
    >
      <div className="min-h-0 overflow-hidden">
        <ChatMarkdown text={text} />
      </div>
    </div>
  );
};
