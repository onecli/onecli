"use client";

import { useEffect, useState } from "react";
import { Bot, Loader2, Terminal } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { cn } from "@onecli/ui/lib/utils";
import { getInstallInfo } from "@/lib/actions/secrets";
import { IS_CLOUD } from "@/lib/env";
import { TryDemoCommand } from "./try-demo-command";

const CODING_AGENTS = [
  { id: "claude-code", name: "Claude Code", runAlias: "claude" },
  { id: "cursor", name: "Cursor", runAlias: "cursor" },
  { id: "codex", name: "Codex", runAlias: "codex" },
  { id: "github-copilot", name: "GitHub Copilot", runAlias: "copilot" },
] as const;

type AgentId = (typeof CODING_AGENTS)[number]["id"];

interface GetStartedDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const GetStartedDialog = ({
  open,
  onOpenChange,
}: GetStartedDialogProps) => {
  const [installInfo, setInstallInfo] = useState<{
    apiKey: string | null;
    agentToken: string | null;
    gatewayUrl: string;
    appUrl: string;
    apiUrl: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeSection, setActiveSection] = useState<"agents" | "autonomous">(
    "agents",
  );
  const [selectedAgent, setSelectedAgent] = useState<AgentId>("claude-code");

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setActiveSection("agents");
    getInstallInfo({ fallbackToDefault: true })
      .then(setInstallInfo)
      .finally(() => setLoading(false));
  }, [open]);

  const buildCurlCommand = (path: string) => {
    if (!installInfo?.apiKey || !IS_CLOUD) return null;
    const params = [`key=${installInfo.apiKey}`];
    if (installInfo.appUrl !== "https://app.onecli.sh") {
      params.push(`url=${encodeURIComponent(installInfo.apiUrl)}`);
    }
    return `curl -fsSL "${installInfo.apiUrl}/v1/${path}?${params.join("&")}" | sh`;
  };

  const migrateCommand = buildCurlCommand("migrate/nanoclaw");

  const activeAgentDef = CODING_AGENTS.find((a) => a.id === selectedAgent)!;

  const buildCliInstallCommand = () => {
    if (!installInfo?.apiKey || !IS_CLOUD) return null;
    const params = [`key=${installInfo.apiKey}`];
    if (installInfo.appUrl !== "https://app.onecli.sh") {
      params.push(`url=${encodeURIComponent(installInfo.apiUrl)}`);
    }
    params.push(`agent=${encodeURIComponent(selectedAgent)}`);
    return `curl -fsSL "${installInfo.apiUrl}/v1/install/cli?${params.join("&")}" | sh`;
  };

  const cliInstallCommand = buildCliInstallCommand();
  const runCommand = `onecli run -- ${activeAgentDef.runAlias}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-xl">
        <DialogHeader className="p-6 pb-4">
          <DialogTitle>Get Started</DialogTitle>
          <DialogDescription>
            Choose how you want to use OneCLI.
          </DialogDescription>
        </DialogHeader>

        {loading && IS_CLOUD ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="text-muted-foreground size-5 animate-spin" />
          </div>
        ) : (
          <div className="px-6 pb-6">
            {/* Section selector */}
            <div className="grid grid-cols-2 gap-2">
              <SectionCard
                icon={Bot}
                title="Coding Agents"
                description="Connect a coding agent to OneCLI"
                active={activeSection === "agents"}
                onClick={() => setActiveSection("agents")}
              />
              <SectionCard
                icon={Terminal}
                title="Autonomous Agents"
                description="Connect an autonomous agent to OneCLI"
                active={activeSection === "autonomous"}
                onClick={() => setActiveSection("autonomous")}
              />
            </div>

            {/* Section content */}
            <div className="mt-4">
              {activeSection === "agents" && (
                <div className="space-y-3">
                  <div className="flex gap-1 rounded-md border p-0.5">
                    {CODING_AGENTS.map((agent) => (
                      <button
                        key={agent.id}
                        type="button"
                        onClick={() => setSelectedAgent(agent.id)}
                        className={cn(
                          "flex-1 rounded-sm px-2 py-1 text-xs font-medium transition-colors",
                          selectedAgent === agent.id
                            ? "bg-muted text-foreground"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {agent.name}
                      </button>
                    ))}
                  </div>

                  {cliInstallCommand ? (
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <p className="text-muted-foreground text-xs">
                          <span className="bg-muted text-foreground mr-1.5 inline-flex size-4 items-center justify-center rounded-full text-[10px] font-semibold">
                            1
                          </span>
                          Install the CLI:
                        </p>
                        <TryDemoCommand command={cliInstallCommand} />
                      </div>
                      <div className="space-y-2">
                        <p className="text-muted-foreground text-xs">
                          <span className="bg-muted text-foreground mr-1.5 inline-flex size-4 items-center justify-center rounded-full text-[10px] font-semibold">
                            2
                          </span>
                          Run {activeAgentDef.name} through OneCLI:
                        </p>
                        <TryDemoCommand command={runCommand} />
                      </div>
                    </div>
                  ) : (
                    <p className="text-muted-foreground rounded-lg border p-4 text-sm">
                      One-command install is available with{" "}
                      <a
                        href="https://app.onecli.sh"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-foreground font-medium underline underline-offset-2"
                      >
                        OneCLI Cloud
                      </a>
                      .
                    </p>
                  )}
                </div>
              )}

              {activeSection === "autonomous" && (
                <div className="space-y-3">
                  {IS_CLOUD && migrateCommand ? (
                    <>
                      <p className="text-muted-foreground text-xs">
                        Already running NanoClaw? Migrate to OneCLI cloud:
                      </p>
                      <TryDemoCommand command={migrateCommand} />
                      <p className="text-muted-foreground text-xs">
                        This updates your CLI config, NanoClaw .env, and
                        restarts the service. Secrets and app connections need
                        to be re-added in the dashboard.
                      </p>
                      <p className="text-muted-foreground text-xs">
                        Don&apos;t have NanoClaw yet?{" "}
                        <a
                          href="https://docs.nanoclaw.dev/introduction"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-foreground font-medium underline underline-offset-2"
                        >
                          Get started here
                        </a>
                        , then come back to migrate.
                      </p>
                    </>
                  ) : IS_CLOUD ? (
                    <div className="flex items-center justify-center py-6">
                      <Loader2 className="text-muted-foreground size-4 animate-spin" />
                    </div>
                  ) : (
                    <div className="rounded-lg border p-4">
                      <p className="text-sm">
                        Migration is available with{" "}
                        <a
                          href="https://app.onecli.sh"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-foreground font-medium underline underline-offset-2 transition-colors hover:text-foreground/80"
                        >
                          OneCLI Cloud
                        </a>
                        .
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

const SectionCard = ({
  icon: Icon,
  title,
  description,
  active,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  active: boolean;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    className={cn(
      "flex flex-col gap-1.5 rounded-lg border p-3 text-left transition-colors",
      active
        ? "border-foreground/20 bg-muted/60"
        : "border-border hover:bg-muted/30",
    )}
  >
    <div className="flex items-center gap-2">
      <Icon
        className={cn(
          "size-3.5",
          active ? "text-foreground" : "text-muted-foreground/60",
        )}
      />
      <p
        className={cn(
          "text-sm font-medium",
          !active && "text-muted-foreground",
        )}
      >
        {title}
      </p>
    </div>
    <p className="text-muted-foreground text-xs">{description}</p>
  </button>
);
