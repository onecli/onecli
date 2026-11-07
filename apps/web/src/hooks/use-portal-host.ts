"use client";

import {
  useCallback,
  useLayoutEffect,
  useState,
  type RefCallback,
} from "react";

/**
 * A DOM node for React content to portal into, while the node itself moves
 * around the page. The content's state (a draft, staged files, scroll, live
 * effects) survives a move because its portal target never changes: only the
 * node moves, never the React subtree.
 *
 * `home` is a ref callback for the element the node normally lives in. Another
 * owner may take the node elsewhere on the page (the desktop theater shows the
 * chat beside the screen) and hand it back later. `home` only places the node
 * when it is on no page at all: the first mount, or a home element that was
 * replaced and took the node off the page with it.
 *
 * The node is created once per mount and never replaced. React hides a subtree
 * (a Suspense fallback, a hidden `<Activity>`) by running its layout-effect
 * cleanups and detaching its refs, and runs both again when it shows it. A node
 * made in a layout effect whose cleanup removes it would be replaced on every
 * reveal: the content remounts into the new node, and a ref still holding the
 * old one puts it back, empty, beside the new one.
 *
 * `className` is read once, when the node is made.
 */
export const usePortalHost = (
  className: string,
): { host: HTMLDivElement | null; home: RefCallback<HTMLElement> } => {
  // Made after mount: the server renders no node, and the client's hydrating
  // render must match it. No cleanup on purpose: a hide runs cleanups too, and
  // an unmount takes the node off the page with its home element.
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (host) return;
    const node = document.createElement("div");
    node.className = className;
    // StrictMode runs this twice before the first node lands: keep the first.
    setHost((current) => current ?? node);
  }, [host, className]);

  const home = useCallback(
    (slot: HTMLElement | null) => {
      if (slot && host && !host.isConnected) slot.appendChild(host);
    },
    [host],
  );

  return { host, home };
};
