"use client";

import { useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import {
  listChannelAlerts,
  type LostChannelConnectionItem,
} from "@/lib/api/channel-alerts";
import { queryKeys } from "@/lib/api/keys";
import { getWorkspaceId } from "@/lib/api-fetch";
import { hasWorkspaceContext } from "@/lib/navigation";

/**
 * Alerts acted on, per browser. Keyed by presence id + the moment it was
 * lost, so acting on an alert clears it from the bell while a LATER loss of
 * the same agent (a new lostAt) alerts again. The agent's Channels tab keeps
 * showing the removed state regardless: that is where the fix lives.
 */
const STORAGE_KEY = "onecli.channel-alerts.seen";
/** Old keys for long-fixed agents are dead weight. */
const MAX_SEEN = 200;
const seenSchema = z.array(z.string());
const EMPTY: ReadonlySet<string> = new Set();

const listeners = new Set<() => void>();
/** The parsed set, re-parsed only when the stored string changes. */
let cached: { raw: string | null; seen: ReadonlySet<string> } = {
  raw: null,
  seen: EMPTY,
};

const readRaw = (): string | null => {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

const parseSeen = (raw: string | null): ReadonlySet<string> => {
  if (!raw) return EMPTY;
  try {
    const parsed = seenSchema.safeParse(JSON.parse(raw));
    return parsed.success ? new Set(parsed.data) : EMPTY;
  } catch {
    return EMPTY;
  }
};

/** A stable snapshot for `useSyncExternalStore`: the same set until the
 * stored value changes. */
const snapshot = (): ReadonlySet<string> => {
  const raw = readRaw();
  if (raw !== cached.raw) cached = { raw, seen: parseSeen(raw) };
  return cached.seen;
};

const seenKey = (item: LostChannelConnectionItem) =>
  `${item.id}@${item.lostAt}`;

/** Mark an alert seen: it leaves the bell for this browser. */
export const dismissChannelAlert = (item: LostChannelConnectionItem) => {
  const seen = [...snapshot(), seenKey(item)].slice(-MAX_SEEN);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seen));
  } catch {
    // Storage unavailable (private mode): the alert simply stays.
  }
  listeners.forEach((notify) => notify());
};

const subscribe = (notify: () => void) => {
  listeners.add(notify);
  window.addEventListener("storage", notify);
  return () => {
    listeners.delete(notify);
    window.removeEventListener("storage", notify);
  };
};

/**
 * The bell's "Needs attention" arm: agents that lost their channel
 * connection and that this browser hasn't acted on yet. Slow poll (a lost
 * connection is a days-scale fact); the list empties by itself once the
 * agent is re-attached.
 */
export const useChannelAlerts = () => {
  const pathname = usePathname();
  const workspaceId = getWorkspaceId();
  const seen = useSyncExternalStore(subscribe, snapshot, () => EMPTY);
  const query = useQuery({
    queryKey: queryKeys.approvals.alerts(workspaceId ?? "none"),
    queryFn: () => listChannelAlerts(workspaceId as string),
    enabled: hasWorkspaceContext(pathname) && workspaceId !== undefined,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
  return {
    ...query,
    data: query.data?.filter((item) => !seen.has(seenKey(item))),
  };
};
