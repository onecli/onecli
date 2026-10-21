"use client";

import type { Ref } from "react";
import {
  Eye,
  Hand,
  Keyboard,
  MessageSquare,
  SquareMousePointer,
} from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { cn } from "@onecli/ui/lib/utils";
import type { DesktopState } from "./api";
import type { DesktopViewStatus } from "./desktop-view";

export interface DesktopControlPillProps {
  state: DesktopState;
  status: DesktopViewStatus;
  /** The person is pressing Take control (the request is in flight). */
  taking: boolean;
  /** The person is pressing Stop (the request is in flight). */
  stopping: boolean;
  onTake: () => void;
  onStop: () => void;
  /** Stop's button, so Esc on the captured canvas can land on it. */
  stopRef?: Ref<HTMLButtonElement>;
  /**
   * The theater's chat column toggle, when the host has one (the in-app
   * theater does; the theater page does not). The bar's trailing segment.
   */
  chat?: { open: boolean; onToggle: () => void };
  /**
   * Raise the phone's keyboard onto the screen (DesktopView's bridge).
   * Offered only while driving, and only on a touch device (a coarse
   * pointer): a laptop types straight into the focused canvas.
   */
  onKeyboard?: () => void;
  className?: string;
}

/** One segment of the bar: compact on a mouse, a full 44px touch target
 * on a finger. */
const SEGMENT =
  "h-[30px] rounded-[7px] px-3 text-[13px] pointer-coarse:h-11 pointer-coarse:px-4";
/** The bar is always light: one white object on the theater's dark
 * ground, whatever the page theme (the theater page sits in the dark
 * shell). Its colors are fixed here rather than taken from the theme. */
const PRIMARY = "bg-neutral-900 text-white hover:bg-neutral-800";
const QUIET =
  "bg-transparent text-neutral-700 hover:bg-neutral-100 hover:text-neutral-900";
const SOFT = "bg-neutral-100 text-neutral-900 hover:bg-neutral-200";

/**
 * The control bar under the screen: who holds the mouse, and the one action the viewer may take now. Watching
 * (Take control), driving (Stop, which hands the screen straight back),
 * and someone else driving (their name, nothing to press). A compact
 * segmented bar, light on the theater's dark scrim, so it reads as the one
 * control in the room without competing with the screen.
 *
 * A toolbar: reachable by Tab, the status `aria-live` so a screen reader
 * hears control change hands, and visible on touch (no hover-only
 * affordance).
 */
export const DesktopControlPill = ({
  state,
  status,
  taking,
  stopping,
  onTake,
  onStop,
  stopRef,
  chat,
  onKeyboard,
  className,
}: DesktopControlPillProps) => {
  const controlling = state.you.controlling;
  const other = !controlling && state.controller ? state.controller : null;
  const canTake = !controlling && !other && status === "connected";

  return (
    <div
      role="toolbar"
      aria-label="Desktop control"
      className={cn(
        "pointer-events-auto flex items-center gap-0.5 rounded-[10px] bg-white p-[3px] text-neutral-900 shadow-[0_1px_2px_rgb(0_0_0/0.2),0_10px_30px_-10px_rgb(0_0_0/0.5)]",
        className,
      )}
    >
      <p
        className={cn(
          "flex min-w-0 items-center gap-1.5 pr-2 pl-2.5 text-[13px]",
          controlling ? "font-medium" : "text-neutral-500",
        )}
        aria-live="polite"
      >
        {controlling ? (
          <>
            <SquareMousePointer className="size-3.5 shrink-0" aria-hidden />
            You’re in control
          </>
        ) : other ? (
          <>
            <Hand className="size-3.5 shrink-0" aria-hidden />
            <span className="max-w-48 truncate">
              {other.name} is in control
            </span>
          </>
        ) : (
          <>
            <Eye className="size-3.5 shrink-0" aria-hidden />
            Watching
          </>
        )}
      </p>
      {controlling ? (
        <>
          {onKeyboard && (
            <Button
              size="sm"
              variant="ghost"
              className={cn(
                SEGMENT,
                QUIET,
                "hidden pointer-coarse:inline-flex",
              )}
              // Synchronous in the tap: iOS raises the keyboard only for a
              // focus made inside the gesture's own handler.
              onClick={onKeyboard}
              data-desktop-keyboard
            >
              <Keyboard className="size-3.5" aria-hidden />
              Keyboard
            </Button>
          )}
          <Button
            ref={stopRef}
            size="sm"
            variant="secondary"
            className={cn(SEGMENT, SOFT)}
            onClick={onStop}
            loading={stopping}
            data-desktop-stop
          >
            Stop
          </Button>
        </>
      ) : (
        <Button
          size="sm"
          className={cn(SEGMENT, PRIMARY)}
          onClick={onTake}
          data-desktop-take-control
          loading={taking}
          disabled={!canTake}
        >
          {taking ? "Taking control…" : "Take control"}
        </Button>
      )}
      {chat && (
        <>
          <span className="mx-1 h-4 w-px bg-neutral-200" aria-hidden />
          <Button
            size="sm"
            variant="ghost"
            className={cn(SEGMENT, QUIET, "aria-pressed:bg-neutral-100")}
            onClick={chat.onToggle}
            aria-pressed={chat.open}
          >
            <MessageSquare className="size-3.5" aria-hidden />
            Chat
          </Button>
        </>
      )}
    </div>
  );
};
