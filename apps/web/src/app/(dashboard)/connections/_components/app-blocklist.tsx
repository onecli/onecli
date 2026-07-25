"use client";

import { Globe, Loader2, ShieldBan, X } from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@onecli/ui/components/accordion";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import { Switch } from "@onecli/ui/components/switch";
import {
  useAppBlocklist,
  useToggleBlocklistRule,
  useActivateBlocklistHost,
} from "@/hooks/use-app-blocklist";
import { withProjectPrefix } from "@/lib/navigation";
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
  const pathname = usePathname();
  const toggleMutation = useToggleBlocklistRule(provider, pageScope);
  const activateMutation = useActivateBlocklistHost(provider, pageScope);

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

  const isMutating = toggleMutation.isPending || activateMutation.isPending;

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
                  {states.map((host) => (
                    <HostRow
                      key={host.hostId}
                      host={host}
                      onToggle={handleToggle}
                      disabled={isMutating}
                      orgLocked={isOrgLocked(host)}
                    />
                  ))}
                </div>
                <p className="text-muted-foreground text-xs">
                  To block any other host, add a rule on the{" "}
                  <Link
                    href={withProjectPrefix(pathname, "/policy")}
                    className="underline underline-offset-2 hover:text-foreground"
                  >
                    Policy
                  </Link>{" "}
                  page.
                </p>
              </>
            )}
          </Card>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
};
