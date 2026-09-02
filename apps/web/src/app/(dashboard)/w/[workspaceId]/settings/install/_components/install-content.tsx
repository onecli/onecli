"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { PageHeader } from "@dashboard/page-header";
import { TryDemoCommand } from "@/app/(dashboard)/_components/try-demo-command";
import { useAgents } from "@/hooks/use-agents";
import { useInstallInfo } from "@/hooks/use-install-info";
import { IS_CLOUD } from "@/lib/env";
import {
  CODING_TOOLS,
  buildCliInstallCommand,
  buildRunCommand,
} from "@/lib/install-command";
import { AgentContextSelect } from "./agent-context-select";
import { InstallStep } from "./install-step";
import { SetupStatusCard } from "./setup-status-card";
import { ToolPills, type ToolSelection } from "./tool-pills";

export const InstallContent = () => {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { data: agents = [] } = useAgents();
  const { data: installInfo } = useInstallInfo();

  const [tool, setTool] = useState<ToolSelection>("claude-code");

  // The URL is the single source of truth for the agent choice:
  // `?agent=<identifier>` — how the org-level Get Started picker deep-links in,
  // and what the select below writes. No param = the first agent in the list,
  // purely as a starting selection: the server resolves nothing implicitly for
  // a post-v2 workspace (omission only falls back to a pre-v2 legacy default,
  // which these pages don't model), so installs always pin explicitly.
  const requestedIdentifier = searchParams.get("agent");
  const selectedAgent =
    (requestedIdentifier
      ? agents.find((a) => a.identifier === requestedIdentifier)
      : undefined) ?? agents[0];

  const selectAgent = (agentId: string) => {
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) return;
    router.replace(
      `${pathname}?agent=${encodeURIComponent(agent.identifier)}`,
      { scroll: false },
    );
  };

  const activeTool =
    tool === "other" ? undefined : CODING_TOOLS.find((t) => t.id === tool);

  // Every install pins: an unpinned machine has nothing to resolve on a
  // post-v2 workspace, so the command always carries the chosen agent.
  const pinIdentifier = selectedAgent?.identifier;

  const installCommand =
    IS_CLOUD && installInfo?.apiKey
      ? buildCliInstallCommand(
          {
            apiUrl: installInfo.apiUrl,
            appUrl: installInfo.appUrl,
            apiKey: installInfo.apiKey,
          },
          { tool: activeTool?.id, agentIdentifier: pinIdentifier },
        )
      : null;

  const runAlias = activeTool?.runAlias ?? "<your-command>";
  const runCommand = buildRunCommand(runAlias);
  const overrideExample = buildRunCommand(
    runAlias,
    pinIdentifier ?? "my-agent",
  );

  // Self-host / OSS: the one-liner endpoint is cloud-only, so spell the same
  // setup out manually (with this workspace's real key once loaded).
  const manualCommand = [
    "curl -fsSL onecli.sh/cli/install | sh",
    ...(installInfo
      ? [`onecli config set api-host ${installInfo.apiUrl}`]
      : []),
    `onecli auth login --api-key ${installInfo?.apiKey ?? "oc_..."}`,
    ...(pinIdentifier ? [`onecli config set agent ${pinIdentifier}`] : []),
  ].join("\n");

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader
          title="Install"
          description="Run your coding agent through OneCLI. Credentials are injected at the gateway, never stored on your machine."
        />
        <AgentContextSelect
          agents={agents}
          value={selectedAgent?.id ?? ""}
          onChange={selectAgent}
        />
      </div>

      <div className="flex max-w-2xl flex-col gap-2">
        <ol className="list-none">
          <InstallStep
            number={1}
            title="Choose your tool"
            description="The commands below adapt to your pick."
          >
            <ToolPills value={tool} onChange={setTool} />
          </InstallStep>

          <InstallStep
            number={2}
            title="Install & sign in"
            description={
              installCommand
                ? `One command: installs the CLI and signs in to this workspace${
                    pinIdentifier
                      ? `, pinning this machine to ${selectedAgent?.name ?? pinIdentifier}`
                      : ""
                  }.`
                : "Install the CLI, point it at this instance, and sign in."
            }
          >
            <TryDemoCommand command={installCommand ?? manualCommand} />
            {installCommand && pinIdentifier && (
              <p className="text-muted-foreground mt-2 text-xs">
                Already have the CLI?{" "}
                <code className="bg-muted rounded px-1 py-0.5 font-mono text-[11px]">
                  onecli config set agent {pinIdentifier}
                </code>{" "}
                does the pinning on its own.
              </p>
            )}
          </InstallStep>

          <InstallStep
            number={3}
            title="Run it"
            description={
              activeTool
                ? `Launches ${activeTool.name} behind the gateway. Proxy and CA are configured for you.`
                : "Launches any command behind the gateway. Proxy and CA are configured for you."
            }
            last
          >
            <TryDemoCommand command={runCommand} />
            <p className="text-muted-foreground mt-2 text-xs">
              One-off identity switch:{" "}
              <code className="bg-muted rounded px-1 py-0.5 font-mono text-[11px]">
                {overrideExample}
              </code>
            </p>
          </InstallStep>
        </ol>

        <SetupStatusCard agent={selectedAgent} />
      </div>
    </>
  );
};
