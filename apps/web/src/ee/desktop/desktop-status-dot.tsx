import { cn } from "@onecli/ui/lib/utils";
import type { DesktopState } from "./api";

/** What the computer is doing, in a word or two, beside its name. */
export const desktopStatusLabel = (state: DesktopState): string => {
  if (state.request) return "Needs you";
  if (state.you.controlling) return "You’re in control";
  if (state.controller) return `${state.controller.name} is in control`;
  switch (state.sandboxState) {
    case "awake":
      return "Live";
    case "waking":
      return "Waking up";
    case "asleep":
      return "Asleep";
    default:
      return "Can’t show the screen";
  }
};

/**
 * The computer's state as a dot: brand green and breathing while live,
 * amber while the agent waits on a person (the dashboard's one "needs
 * you" colour) or while it wakes, grey at rest.
 */
export const DesktopStatusDot = ({ state }: { state: DesktopState }) => {
  const tone = state.request
    ? "bg-amber-500"
    : state.sandboxState === "awake"
      ? "bg-brand"
      : state.sandboxState === "waking"
        ? "bg-amber-400"
        : "bg-muted-foreground/50";
  const pulse =
    state.request ||
    state.sandboxState === "awake" ||
    state.sandboxState === "waking";
  return (
    <span aria-hidden className="relative flex size-2 shrink-0">
      {pulse && (
        <span
          className={cn(
            "absolute inset-0 rounded-full opacity-60 motion-safe:animate-ping",
            tone,
          )}
        />
      )}
      <span className={cn("relative size-2 rounded-full", tone)} />
    </span>
  );
};
