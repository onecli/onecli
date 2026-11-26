"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadTurnstile } from "@/ee/auth/turnstile-script";

export interface TurnstileOptions {
  /** The widget's public sitekey; empty disables the widget entirely. */
  siteKey: string;
  /** Bound into the token; the server rejects tokens for other actions. */
  action: string;
  /**
   * Applied when the widget renders. A later change does not re-render it:
   * that would discard a token the visitor already earned.
   */
  theme: Turnstile.Theme;
}

export interface TurnstileHandle {
  /** Attach to the element the widget renders into. */
  containerRef: (element: HTMLDivElement | null) => void;
  /**
   * A current token, waiting for the widget if it is still solving.
   * Resolves `undefined` (never rejects) when verification is unavailable:
   * disabled, blocked, failed, or not solved in time. The server decides
   * what a missing token means.
   */
  getToken: () => Promise<string | undefined>;
  /** Tokens are single-use: call after every request that carried one. */
  consume: () => void;
  /** Cloudflare is showing the visitor a challenge to complete. */
  needsInteraction: boolean;
}

/** How long to wait for a widget that is still solving on its own. */
const SOFT_WAIT_MS = 15_000;
/** How long to wait once the visitor has been shown a challenge to solve. */
const INTERACTIVE_WAIT_MS = 120_000;
const POLL_MS = 250;

/**
 * Cloudflare Turnstile, rendered explicitly into a container the caller
 * owns. Managed mode with `interaction-only` appearance: most visitors never
 * see it, and only a visitor Cloudflare is unsure about gets a checkbox. It
 * renders as soon as the container mounts, so a token is usually ready
 * before the visitor submits, and it re-renders (fresh token) whenever the
 * container remounts.
 */
export const useTurnstile = ({
  siteKey,
  action,
  theme,
}: TurnstileOptions): TurnstileHandle => {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [needsInteraction, setNeedsInteraction] = useState(false);
  const api = useRef<Turnstile.Turnstile | undefined>(undefined);
  const widgetId = useRef<string | undefined>(undefined);
  const token = useRef<string | undefined>(undefined);
  const failed = useRef(false);
  const interactive = useRef(false);
  const waiters = useRef(new Set<(value: string | undefined) => void>());
  const themeRef = useRef(theme);
  useEffect(() => {
    themeRef.current = theme;
  }, [theme]);

  const settle = useCallback((value: string | undefined) => {
    for (const resolve of [...waiters.current]) resolve(value);
  }, []);

  const setInteractive = useCallback((value: boolean) => {
    interactive.current = value;
    setNeedsInteraction(value);
  }, []);

  useEffect(() => {
    if (!siteKey || !container) return;
    let cancelled = false;
    failed.current = false;
    setInteractive(false);
    token.current = undefined;

    loadTurnstile()
      .then((turnstile) => {
        if (cancelled) return;
        api.current = turnstile;
        widgetId.current =
          turnstile.render(container, {
            sitekey: siteKey,
            action,
            theme: themeRef.current,
            size: "flexible",
            appearance: "interaction-only",
            "response-field": false,
            callback: (value) => {
              token.current = value;
              failed.current = false;
              setInteractive(false);
              settle(value);
            },
            // Expired tokens are refreshed automatically (the default
            // refresh-expired mode); until then there is no usable token.
            "expired-callback": () => {
              token.current = undefined;
            },
            // Turnstile retries on its own; a later success clears this.
            "error-callback": () => {
              token.current = undefined;
              failed.current = true;
              settle(undefined);
            },
            "timeout-callback": () => {
              token.current = undefined;
              setInteractive(false);
              settle(undefined);
            },
            "unsupported-callback": () => {
              failed.current = true;
              settle(undefined);
            },
            "before-interactive-callback": () => {
              setInteractive(true);
            },
            "after-interactive-callback": () => {
              setInteractive(false);
            },
          }) ?? undefined;
      })
      .catch(() => {
        if (cancelled) return;
        failed.current = true;
        settle(undefined);
      });

    return () => {
      cancelled = true;
      if (widgetId.current !== undefined) {
        api.current?.remove(widgetId.current);
      }
      widgetId.current = undefined;
      token.current = undefined;
      setInteractive(false);
      settle(undefined);
    };
  }, [siteKey, container, action, settle, setInteractive]);

  const getToken = useCallback((): Promise<string | undefined> => {
    if (!siteKey) return Promise.resolve(undefined);
    const id = widgetId.current;
    if (token.current && id !== undefined && !api.current?.isExpired(id)) {
      return Promise.resolve(token.current);
    }
    if (failed.current) return Promise.resolve(undefined);

    return new Promise((resolve) => {
      const startedAt = Date.now();
      const done = (value: string | undefined) => {
        clearInterval(timer);
        waiters.current.delete(done);
        resolve(value);
      };
      const timer = setInterval(() => {
        const waited = Date.now() - startedAt;
        const limit = interactive.current ? INTERACTIVE_WAIT_MS : SOFT_WAIT_MS;
        if (waited >= limit) done(undefined);
      }, POLL_MS);
      waiters.current.add(done);
    });
  }, [siteKey]);

  const consume = useCallback(() => {
    token.current = undefined;
    const id = widgetId.current;
    if (id !== undefined) api.current?.reset(id);
  }, []);

  return { containerRef: setContainer, getToken, consume, needsInteraction };
};
