"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bot, Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Badge } from "@onecli/ui/components/badge";
import { Checkbox } from "@onecli/ui/components/checkbox";
import {
  useConnectionAgents,
  useSetConnectionAgents,
} from "@/hooks/use-connections";
import { withProjectPrefix } from "@/lib/navigation";

interface ConnectionAgentAccessDialogProps {
  connectionId: string;
  connectionLabel: string;
  appName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Connection-first mirror of the agent-side "Credential access" dialog: pick
 * which agents can use one connection. All-mode agents already reach every
 * connection, so they show as read-only "Full access"; only selective agents
 * are toggled. Scales to many agents via a name filter + select-all/clear, with
 * a viewport-bounded scroll list so the dialog never overflows.
 */
export const ConnectionAgentAccessDialog = ({
  connectionId,
  connectionLabel,
  appName,
  open,
  onOpenChange,
}: ConnectionAgentAccessDialogProps) => {
  const pathname = usePathname();
  const agentsHref = withProjectPrefix(pathname, "/agents");

  const { data: agentAccess = [], isPending } = useConnectionAgents(
    connectionId,
    open,
  );
  const setAgents = useSetConnectionAgents();

  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");

  // The set of selective agents currently granted this connection.
  const initialSelected = useMemo(
    () =>
      new Set(
        agentAccess.filter((a) => a.access === "assigned").map((a) => a.id),
      ),
    [agentAccess],
  );

  // Seed the edit buffer once per open, once access loads — guarded so a
  // background refetch can't clobber in-progress edits. Search clears on close.
  const seededRef = useRef(false);
  useEffect(() => {
    if (!open) {
      seededRef.current = false;
      setSearch("");
      return;
    }
    if (seededRef.current || isPending) return;
    setSelected(new Set(initialSelected));
    seededRef.current = true;
  }, [open, isPending, initialSelected]);

  // Selective (togglable) agents — all-mode agents always have full access and
  // aren't selectable here.
  const selectableAgents = useMemo(
    () => agentAccess.filter((a) => a.access !== "full"),
    [agentAccess],
  );
  const allFull = agentAccess.length > 0 && selectableAgents.length === 0;

  const filteredAgents = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return agentAccess;
    return agentAccess.filter((a) => a.name.toLowerCase().includes(q));
  }, [agentAccess, search]);

  const dirty = useMemo(() => {
    if (selected.size !== initialSelected.size) return true;
    for (const id of selected) if (!initialSelected.has(id)) return true;
    return false;
  }, [selected, initialSelected]);

  const toggle = (agentId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };

  // Select-all/clear act on every selective agent, not just the filtered view
  // (matches the agent-side dialog).
  const selectAll = () =>
    setSelected(new Set(selectableAgents.map((a) => a.id)));
  const clearAll = () => setSelected(new Set());

  const handleSave = async () => {
    setSaving(true);
    try {
      await setAgents.mutateAsync({ connectionId, agentIds: [...selected] });
      onOpenChange(false);
      toast.success("Agent access updated");
    } catch {
      toast.error("Failed to update agent access");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="p-6 pb-4">
          <DialogTitle>Agent access for {connectionLabel}</DialogTitle>
          <p className="text-muted-foreground text-xs leading-relaxed">
            Choose which agents can use this {appName} connection. Credentials
            are injected by the gateway at request time; the agent never sees
            raw values.
          </p>
        </DialogHeader>

        <div className="px-6 pb-1">
          {isPending ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="text-muted-foreground size-4 animate-spin" />
            </div>
          ) : agentAccess.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <div className="bg-muted mb-3 flex size-10 items-center justify-center rounded-full">
                <Bot className="text-muted-foreground size-4" />
              </div>
              <p className="text-sm font-medium">No agents yet</p>
              <p className="text-muted-foreground mt-1 text-xs">
                Create an agent to grant it access to this connection.
              </p>
              <Button asChild variant="outline" size="sm" className="mt-3">
                <Link href={agentsHref}>Go to Agents</Link>
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              {allFull && (
                <p className="text-muted-foreground bg-muted/40 rounded-md px-3 py-2 text-xs">
                  Every agent has full credential access. To limit an agent to
                  specific connections, set it to Selective on the{" "}
                  <Link href={agentsHref} className="underline">
                    Agents
                  </Link>{" "}
                  page.
                </p>
              )}

              {/* Search */}
              <div className="relative">
                <Search
                  className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
                  aria-hidden="true"
                />
                <Input
                  placeholder="Filter agents..."
                  aria-label="Filter agents by name"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-8 pl-8 text-sm"
                />
              </div>

              {/* Toolbar: count + bulk actions (selective agents only) */}
              {selectableAgents.length > 0 && (
                <div className="flex items-center justify-between">
                  <p
                    className="text-muted-foreground text-xs"
                    aria-live="polite"
                  >
                    <span className="text-foreground font-medium">
                      {selected.size}
                    </span>{" "}
                    of {selectableAgents.length} selected
                  </p>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={selectAll}
                      className="text-muted-foreground hover:text-foreground text-xs transition-colors"
                    >
                      Select all
                    </button>
                    <span className="text-muted-foreground/40 text-xs">/</span>
                    <button
                      type="button"
                      onClick={clearAll}
                      className="text-muted-foreground hover:text-foreground text-xs transition-colors"
                    >
                      Clear
                    </button>
                  </div>
                </div>
              )}

              {/* List — a native max-height scroller: it shrinks to fit a few
                  agents and caps at the viewport, scrolling the rows for many.
                  (A Radix ScrollArea can't scroll under `max-height` — its
                  viewport needs a *definite* height — so it would clip instead
                  of scroll; a plain overflow container is correct here.) */}
              <div className="max-h-[min(24rem,50vh)] overflow-y-auto rounded-md border">
                <div className="divide-border divide-y">
                  {filteredAgents.map((agent) => {
                    const isFull = agent.access === "full";
                    return (
                      <label
                        key={agent.id}
                        className={
                          isFull
                            ? "flex items-center gap-3 px-3 py-2.5"
                            : "hover:bg-muted/50 flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors"
                        }
                      >
                        <Checkbox
                          checked={isFull || selected.has(agent.id)}
                          disabled={isFull}
                          onCheckedChange={() => !isFull && toggle(agent.id)}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">
                            {agent.name}
                          </p>
                        </div>
                        {isFull ? (
                          <Badge
                            variant="secondary"
                            className="shrink-0 text-xs"
                          >
                            Full access
                          </Badge>
                        ) : agent.scoped ? (
                          <Badge
                            variant="outline"
                            className="shrink-0 text-xs"
                            title="Limited to specific resources — manage on the Agents page"
                          >
                            Scoped
                          </Badge>
                        ) : null}
                      </label>
                    );
                  })}

                  {filteredAgents.length === 0 && (
                    <p className="text-muted-foreground py-6 text-center text-xs">
                      No agents match &ldquo;{search}&rdquo;
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="border-border/50 border-t px-6 py-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            loading={saving}
            disabled={isPending || !dirty}
          >
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
