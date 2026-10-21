"use client";

import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Network } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { useAgentPageAgent } from "../../_components/agent-page-frame";
import { EmptyState } from "../../_components/empty-state";
import {
  portToastId,
  usePorts,
  useSharePort,
  useUnsharePort,
} from "@/hooks/use-ports";
import { PortRow } from "./port-row";

/** How long the Undo stays on screen after a share is stopped. */
const UNDO_MS = 8_000;

/**
 * The agent's Ports section (plans/sandbox-ports.md): which ports are
 * listening inside the agent's computer, and which are shared at a stable
 * preview URL. Phase 1 shares are private — only signed-in members of this
 * workspace can open them.
 *
 * Live: the list refreshes itself every few seconds while the tab is open
 * (`usePorts`), quietly: no indicator, no counter. A new service shows up
 * within one supervisor scan plus one poll, and the empty state says so.
 *
 * Stopping a share is reversible for a moment (an Undo on the toast) instead
 * of a confirm dialog: the link people may have open goes dark at once, which
 * is the safe direction, and a mis-click costs one click to take back.
 */
export const PortsSection = () => {
  const agent = useAgentPageAgent();
  const { data, isPending, isError, refetch } = usePorts(agent.id);
  const [manual, setManual] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);
  const manualId = useId();
  const manualRef = useRef<HTMLInputElement>(null);
  const shareMutation = useSharePort(agent.id);
  const unshareMutation = useUnsharePort(agent.id);

  const share = (port: number) =>
    shareMutation.mutate(port, {
      onSuccess: (s) => toast.success(`Port ${s.port} is shared`),
      onError: (e) => toast.error(e.message),
    });
  // Instant: the share leaves the row on click and Undo is offered at once
  // (it queues behind the stop). A failed stop puts the share back and
  // replaces this toast with its reason.
  const unshare = (port: number) => {
    unshareMutation.mutate(port);
    toast(`Stopped sharing port ${port}`, {
      id: portToastId(agent.id, port),
      description: "The link no longer opens.",
      duration: UNDO_MS,
      action: { label: "Undo", onClick: () => share(port) },
    });
  };

  const shares = data?.shares ?? [];
  const active = new Map(
    shares.filter((s) => s.active).map((s) => [s.port, s]),
  );
  const listening = new Set(data?.listening ?? []);
  const ports = [...new Set([...listening, ...active.keys()])].sort(
    (a, b) => a - b,
  );
  // Sharing waits on the server (it mints the URL the row shows), so only
  // the row being shared shows a spinner and is held; every other row stays
  // usable. Stopping is instant: the share leaves the row on click, so it
  // never holds anything.
  const sharing = shareMutation.isPending ? shareMutation.variables : null;
  const busyFor = (port: number) => (sharing === port ? "share" : null);

  const submitManual = () => {
    const p = Number(manual);
    const problem =
      !Number.isInteger(p) || p < 1 || p > 65_535
        ? "Enter a port between 1 and 65535."
        : active.has(p)
          ? `Port ${p} is already shared.`
          : null;
    if (problem) {
      setManualError(problem);
      manualRef.current?.focus();
      return;
    }
    setManualError(null);
    share(p);
    setManual("");
  };

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-base font-semibold text-pretty">Ports</h2>
        <p className="text-muted-foreground text-sm text-pretty">
          Share a service running on this agent’s computer (a dev server, a
          Docker container) at a private link. Only signed-in members of this
          workspace can open it.
        </p>
      </div>

      {isPending ? (
        <ul
          className="divide-y rounded-lg border"
          aria-busy="true"
          aria-label="Loading ports…"
        >
          {[0, 1, 2].map((i) => (
            <li key={i} className="flex items-center gap-4 px-4 py-3">
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-3 w-56" />
              </div>
              <Skeleton className="h-8 w-20" />
            </li>
          ))}
        </ul>
      ) : isError ? (
        <EmptyState
          title="Couldn’t load ports."
          description="Check your connection and try again."
          action={
            <Button size="sm" variant="outline" onClick={() => void refetch()}>
              Try again
            </Button>
          }
        />
      ) : ports.length === 0 ? (
        <EmptyState
          icon={Network}
          title="Nothing is listening yet."
          description="When the agent starts a service, it shows up here within a few seconds. You can also share a port ahead of time below."
        />
      ) : (
        <ul className="divide-y rounded-lg border" aria-live="polite">
          {ports.map((port) => (
            <PortRow
              key={port}
              port={port}
              listening={listening.has(port)}
              share={active.get(port)}
              busy={busyFor(port)}
              onShare={() => share(port)}
              onUnshare={() => unshare(port)}
            />
          ))}
        </ul>
      )}

      <form
        className="space-y-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          submitManual();
        }}
      >
        <Label htmlFor={manualId} className="text-muted-foreground text-xs">
          Share another port
        </Label>
        <div className="flex items-center gap-2">
          <Input
            ref={manualRef}
            id={manualId}
            name="port"
            value={manual}
            onChange={(e) => {
              setManual(e.target.value.replace(/\D/g, "").slice(0, 5));
              if (manualError) setManualError(null);
            }}
            placeholder="3000"
            className="max-w-40 font-mono tabular-nums"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={manualError !== null}
            aria-describedby={manualError ? `${manualId}-error` : undefined}
          />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            loading={sharing !== null && !ports.includes(sharing)}
            disabled={!manual}
          >
            Share
          </Button>
        </div>
        {manualError && (
          <p
            id={`${manualId}-error`}
            role="alert"
            className="text-destructive text-xs"
          >
            {manualError}
          </p>
        )}
      </form>
    </div>
  );
};
