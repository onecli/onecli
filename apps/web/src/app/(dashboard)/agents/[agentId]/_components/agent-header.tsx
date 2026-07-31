"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ArrowLeft, Bot } from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
import { withProjectPrefix } from "@/lib/navigation";
import { CredentialAccessReflection } from "@/lib/components/policy-reflect";
import { AgentActionsMenu } from "../../_components/agent-actions-menu";

interface AgentHeaderProps {
  agent: {
    id: string;
    name: string;
    identifier: string;
    isDefault: boolean;
    createdAt: Date;
  };
}

export const AgentHeader = ({ agent }: AgentHeaderProps) => {
  const pathname = usePathname();
  const router = useRouter();
  const [accessDialogOpen, setAccessDialogOpen] = useState(false);

  return (
    <div className="space-y-6">
      <Link
        href={withProjectPrefix(pathname, "/agents")}
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm transition-colors"
      >
        <ArrowLeft className="size-4" />
        Agents
      </Link>

      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="bg-muted flex size-12 shrink-0 items-center justify-center rounded-xl border">
            <Bot className="text-muted-foreground size-6" aria-hidden />
          </div>
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-xl font-semibold tracking-tight">
                {agent.name}
              </h1>
              {agent.isDefault && (
                <Badge variant="outline" className="text-xs">
                  Default
                </Badge>
              )}
            </div>
            <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <code className="bg-muted rounded px-1.5 py-0.5 font-mono">
                {agent.identifier}
              </code>
              <span>
                Created {new Date(agent.createdAt).toLocaleDateString()}
              </span>
            </div>
          </div>
        </div>

        <AgentActionsMenu
          agent={agent}
          onCredentialAccess={() => setAccessDialogOpen(true)}
          onDeleted={() => router.push(withProjectPrefix(pathname, "/agents"))}
        />
      </div>

      <CredentialAccessReflection
        agent={{ id: agent.id, name: agent.name }}
        open={accessDialogOpen}
        onOpenChange={setAccessDialogOpen}
      />
    </div>
  );
};
