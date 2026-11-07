"use client";

import { useLayoutEffect } from "react";
import { useMessageScroller } from "@onecli/ui/components/message-scroller";
import type { OutgoingMessage } from "@/hooks/use-conversations";
import { PIN_SCROLL_MARGIN_PX } from "./transcript-layout";

/**
 * Moves the view ONCE per send, to where the message just sent belongs:
 *
 * - A fresh exchange (`pin`) goes near the top, the reply writing into the
 *   room below it. Nothing moves the view after that: the jump leaves the
 *   scroller free-scrolling, so it stays still however long the reply grows,
 *   and the end button offers the way down once the reply passes the fold.
 * - A follow-up joins the live run, so it goes to the end, which also
 *   re-arms following: the reader sees their message land and the answer
 *   that folds it in, whether or not they were following before.
 *
 * Both jumps go through the scroller, never a raw `scrollTop` write, so its
 * follow state and the end button match what is on screen. Renders nothing;
 * must sit inside the `MessageScroller`, after the viewport, so the pending
 * row has registered by the time the layout effect runs.
 */
export const ScrollOnSend = ({
  sent,
  pin,
}: {
  sent: OutgoingMessage | undefined;
  pin: boolean;
}) => {
  const { scrollToEnd, scrollToMessage } = useMessageScroller();
  useLayoutEffect(() => {
    if (!sent) return;
    if (pin) {
      scrollToMessage("pending", {
        align: "start",
        scrollMargin: PIN_SCROLL_MARGIN_PX,
      });
    } else {
      scrollToEnd();
    }
    // Once per send: `sent` is the mutation's variables (a new object per
    // send, stable in between), `pin` is set in the same send, and the
    // scroller's commands are stable.
  }, [sent, pin, scrollToEnd, scrollToMessage]);
  return null;
};
