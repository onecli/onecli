"use client";

import { useState } from "react";
import { Globe, Loader2, Plus, ShieldBan, X } from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
import { toast } from "sonner";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@onecli/ui/components/accordion";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import { Separator } from "@onecli/ui/components/separator";
import { Switch } from "@onecli/ui/components/switch";
import {
  useAppBlocklist,
  useToggleBlocklistRule,
  useActivateBlocklistHost,
  useAddBlocklistRule,
  useRemoveBlocklistRule,
} from "@/hooks/use-app-blocklist";
import type { BlocklistHostState } from "@/lib/api/app-blocklist";

interface AppBlocklistProps {
  provider: string;
  hosts: { id: string; name: string; hostPattern: string }[];
  isConnected: boolean;
  pageScope?: "project" | "organization";
}

const HostRow = ({
  host,
  onToggle,
  onRemove,
  disabled,
  orgLocked,
}: {
  host: BlocklistHostState;
  onToggle: (host: BlocklistHostState, enabled: boolean) => void;
  onRemove?: (host: BlocklistHostState) => void;
  disabled?: boolean;
  orgLocked?: boolean;
}) => (
  <div className="group flex items-center gap-3 py-3">
    <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
      <Globe className="size-3.5 text-muted-foreground" />
    </div>
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <p className="text-sm font-medium leading-none">{host.name}</p>
        {orgLocked && (
          <Badge variant="outline" className="text-[10px] font-normal">
            Organization
          </Badge>
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground font-mono">
        {host.hostPattern}
      </p>
    </div>
    <div className="flex items-center gap-1.5">
      {onRemove && !orgLocked && (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive transition-opacity"
          onClick={() => onRemove(host)}
          disabled={disabled}
        >
          <X className="size-3.5" />
        </Button>
      )}
      <Switch
        checked={host.enabled}
        onCheckedChange={(checked) => onToggle(host, checked)}
        disabled={disabled || orgLocked}
      />
    </div>
  </div>
);

const PreviewRow = ({
  name,
  hostPattern,
}: {
  name: string;
  hostPattern: string;
}) => (
  <div className="flex items-center gap-3 py-3">
    <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
      <Globe className="size-3.5 text-muted-foreground" />
    </div>
    <div className="min-w-0 flex-1">
      <p className="text-sm font-medium leading-none">{name}</p>
      <p className="mt-1 text-xs text-muted-foreground font-mono">
        {hostPattern}
      </p>
    </div>
    <Switch checked disabled />
  </div>
);

const AddHostForm = ({
  onAdd,
  isPending,
}: {
  onAdd: (name: string, hostPattern: string) => void;
  isPending: boolean;
}) => {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [host, setHost] = useState("");

  const canSubmit = name.trim().length > 0 && host.trim().length > 0;

  const handleSubmit = () => {
    if (!canSubmit) return;
    onAdd(name.trim(), host.trim());
    setName("");
    setHost("");
    setOpen(false);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 rounded-md border border-dashed border-border/60 px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:border-border hover:text-foreground hover:bg-muted/50"
      >
        <Plus className="size-3.5" />
        Add custom host
      </button>
    );
  }

  return (
    <div className="rounded-md border bg-muted/30 p-3 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="blocklist-name" className="text-xs">
            Display name
          </Label>
          <Input
            id="blocklist-name"
            placeholder="e.g. RubyGems"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-8 text-sm"
            autoFocus
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="blocklist-host" className="text-xs">
            Host pattern
          </Label>
          <Input
            id="blocklist-host"
            placeholder="e.g. rubygems.org"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            className="h-8 text-sm font-mono"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSubmit();
              if (e.key === "Escape") setOpen(false);
            }}
          />
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={() => {
            setOpen(false);
            setName("");
            setHost("");
          }}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          className="h-7 text-xs"
          onClick={handleSubmit}
          disabled={!canSubmit || isPending}
          loading={isPending}
        >
          Block host
        </Button>
      </div>
    </div>
  );
};

export const AppBlocklist = ({
  provider,
  hosts,
  isConnected,
  pageScope = "project",
}: AppBlocklistProps) => {
  const { data: states = [], isPending } = useAppBlocklist(
    provider,
    pageScope,
    isConnected,
  );
  const toggleMutation = useToggleBlocklistRule(provider, pageScope);
  const activateMutation = useActivateBlocklistHost(provider, pageScope);
  const addMutation = useAddBlocklistRule(provider, pageScope);
  const removeMutation = useRemoveBlocklistRule(provider, pageScope);

  const predefinedHosts = states.filter((s) => !s.custom);
  const customHosts = states.filter((s) => s.custom);

  const isOrgLocked = (host: BlocklistHostState) =>
    pageScope === "project" && host.scope === "organization";

  const handleToggle = (host: BlocklistHostState, enabled: boolean) => {
    if (host.ruleId) {
      toggleMutation.mutate(
        { ruleId: host.ruleId, enabled },
        {
          onSuccess: () =>
            toast.success(
              enabled ? `Blocking ${host.name}` : `Unblocked ${host.name}`,
            ),
        },
      );
    } else {
      activateMutation.mutate(host.hostId, {
        onSuccess: () => toast.success(`Blocking ${host.name}`),
      });
    }
  };

  const handleAdd = (name: string, hostPattern: string) => {
    addMutation.mutate(
      { name, hostPattern },
      { onSuccess: () => toast.success(`Blocking ${name}`) },
    );
  };

  const handleRemove = (host: BlocklistHostState) => {
    if (!host.ruleId) return;
    removeMutation.mutate(host.ruleId, {
      onSuccess: () => toast.success(`Removed ${host.name}`),
    });
  };

  const isMutating =
    toggleMutation.isPending ||
    activateMutation.isPending ||
    addMutation.isPending ||
    removeMutation.isPending;

  return (
    <Accordion
      type="single"
      collapsible
      defaultValue={isConnected ? "blocklist" : undefined}
    >
      <AccordionItem value="blocklist" className="border-b-0 border-t">
        <AccordionTrigger className="py-3 hover:no-underline">
          <span className="text-muted-foreground flex items-center gap-2 text-xs font-normal">
            <ShieldBan className="size-3.5" />
            Host blocklist
          </span>
        </AccordionTrigger>
        <AccordionContent className="pb-1">
          <Card className="p-4 space-y-4">
            <div>
              <p className="text-sm font-medium">Blocked registries</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {isConnected
                  ? "Public package registries are blocked to enforce Artifactory usage."
                  : "These registries will be automatically blocked when connected."}
              </p>
            </div>
            {isConnected && isPending ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </div>
            ) : !isConnected ? (
              <div className="divide-y">
                {hosts.map((host) => (
                  <PreviewRow
                    key={host.id}
                    name={host.name}
                    hostPattern={host.hostPattern}
                  />
                ))}
              </div>
            ) : (
              <>
                <div className="divide-y">
                  {predefinedHosts.map((host) => (
                    <HostRow
                      key={host.hostId}
                      host={host}
                      onToggle={handleToggle}
                      disabled={isMutating}
                      orgLocked={isOrgLocked(host)}
                    />
                  ))}
                  {customHosts.length > 0 && (
                    <>
                      <Separator />
                      {customHosts.map((host) => (
                        <HostRow
                          key={host.hostId}
                          host={host}
                          onToggle={handleToggle}
                          onRemove={handleRemove}
                          disabled={isMutating}
                          orgLocked={isOrgLocked(host)}
                        />
                      ))}
                    </>
                  )}
                </div>
                <AddHostForm
                  onAdd={handleAdd}
                  isPending={addMutation.isPending}
                />
              </>
            )}
          </Card>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
};
