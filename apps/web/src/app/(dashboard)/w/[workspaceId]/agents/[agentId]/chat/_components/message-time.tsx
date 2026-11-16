"use client";

import { useSyncExternalStore } from "react";
import { cn } from "@onecli/ui/lib/utils";
import {
  formatMessageTime,
  formatMessageTimeLong,
} from "@/lib/chat/message-time";

/**
 * How a message's quiet line (its time, an answer's copy button) appears:
 * hidden until the message is hovered or holds keyboard focus, then a short
 * fade in, and the same fade out. The fade IN waits a beat (150 ms): a
 * cursor sweeping across the thread on its way somewhere else should not
 * flicker every row it crosses (Tasklet does the same). Leaving hides it
 * without the wait, and keyboard focus shows it at once. Touch has no
 * hover, so there it is always shown. Under reduced motion it appears and
 * goes without the fade. Hidden, it keeps its height, so hovering never
 * moves the text. Needs `group/msg` on the message.
 */
export const REVEAL_ON_HOVER =
  "transition-opacity duration-150 ease-out motion-reduce:transition-none [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/msg:opacity-100 [@media(hover:hover)]:group-hover/msg:delay-150 [@media(hover:hover)]:group-focus-within/msg:opacity-100 [@media(hover:hover)]:group-focus-within/msg:delay-0";

/** The server renders no time: its zone is not the viewer's. */
const subscribe = () => () => {};
const onClient = () => true;
const onServer = () => false;

/**
 * When a message was sent, as a quiet `<time>` the row shows on hover or
 * focus (and always on touch, where there is no hover). In the VIEWER's
 * time zone and locale, with the full date in its tooltip.
 *
 * Rendered only in the browser: the server's zone is not the viewer's, and
 * printing it would flash a wrong time before hydration corrected it. The
 * row reserves the line either way, so nothing shifts when it appears.
 *
 * Reveal is the parent's job: put `group/msg` on the message row and this
 * fades in with `group-hover/msg` and `group-focus-within/msg`.
 */
export const MessageTime = ({
  at,
  className,
}: {
  /** ISO timestamp. */
  at: string;
  className?: string;
}) => {
  const mounted = useSyncExternalStore(subscribe, onClient, onServer);
  if (!mounted) return null;
  const label = formatMessageTime(at, new Date());
  if (!label) return null;
  return (
    <time
      dateTime={at}
      title={formatMessageTimeLong(at)}
      className={cn("text-muted-foreground text-xs tabular-nums", className)}
    >
      {label}
    </time>
  );
};
