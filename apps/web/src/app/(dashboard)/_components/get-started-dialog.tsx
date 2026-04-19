"use client";

import { useEffect, useState } from "react";
import { Loader2, MessageSquare, Zap } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Button } from "@onecli/ui/components/button";
import { cn } from "@onecli/ui/lib/utils";
import {
  getInstallInfo,
  getDemoInfo,
  seedDemoSecret,
} from "@/lib/actions/secrets";
import { IS_CLOUD } from "@/lib/env";
import { TryDemoCommand } from "./try-demo-command";

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
  } | null>(null);
  const [demoInfo, setDemoInfo] = useState<{
    agentToken: string;
    gatewayUrl: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [activeSection, setActiveSection] = useState<
    "install" | "gateway" | null
  >("install");
  const [installMode, setInstallMode] = useState<"new" | "migrate">("new");

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setActiveSection("install");
    Promise.all([getInstallInfo(), getDemoInfo()])
      .then(([install, demo]) => {
        setInstallInfo(install);
        setDemoInfo(demo);
      })
      .finally(() => setLoading(false));
  }, [open]);

  const buildCurlCommand = (path: string) => {
    if (!installInfo?.apiKey || !IS_CLOUD) return null;
    const params = [`key=${installInfo.apiKey}`];
    if (installInfo.appUrl !== "https://app.onecli.sh") {
      params.push(`url=${encodeURIComponent(installInfo.appUrl)}`);
    }
    return `curl -fsSL "${installInfo.appUrl}/api/${path}?${params.join("&")}" | sh`;
  };

  const installCommand = buildCurlCommand("install/nanoclaw");
  const migrateCommand = buildCurlCommand("migrate/nanoclaw");

  const demoCommand = demoInfo
    ? `curl -k -x http://x:${demoInfo.agentToken}@${demoInfo.gatewayUrl} -H "Authorization: Bearer FAKE_TOKEN" https://httpbin.org/anything`
    : "";

  const handleSeedDemo = async () => {
    setSeeding(true);
    try {
      await seedDemoSecret();
      const info = await getDemoInfo();
      setDemoInfo(info);
    } finally {
      setSeeding(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-xl">
        <DialogHeader className="p-6 pb-4">
          <DialogTitle>Get Started</DialogTitle>
          <DialogDescription>
            Choose how you want to use OneCLI.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="text-muted-foreground size-5 animate-spin" />
          </div>
        ) : (
          <div className="px-6 pb-6">
            {/* Section selector */}
            <div className="grid grid-cols-2 gap-2">
              <SectionCard
                icon={MessageSquare}
                title="Install NanoClaw"
                description="Deploy an AI agent with OneCLI"
                active={activeSection === "install"}
                onClick={() => setActiveSection("install")}
              />
              <SectionCard
                icon={Zap}
                title="Try the gateway"
                description="Test secret injection in 30 seconds"
                active={activeSection === "gateway"}
                onClick={() => setActiveSection("gateway")}
              />
            </div>

            {/* Section content */}
            <div className="mt-4">
              {activeSection === "install" && (
                <div className="space-y-3">
                  {IS_CLOUD && (installCommand || migrateCommand) ? (
                    <>
                      <div className="flex gap-1 rounded-md border p-0.5">
                        <button
                          type="button"
                          onClick={() => setInstallMode("new")}
                          className={cn(
                            "flex-1 rounded-sm px-2 py-1 text-xs font-medium transition-colors",
                            installMode === "new"
                              ? "bg-muted text-foreground"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          New install
                        </button>
                        <button
                          type="button"
                          onClick={() => setInstallMode("migrate")}
                          className={cn(
                            "flex-1 rounded-sm px-2 py-1 text-xs font-medium transition-colors",
                            installMode === "migrate"
                              ? "bg-muted text-foreground"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          Migrate from local
                        </button>
                      </div>

                      {installMode === "new" && installCommand && (
                        <>
                          <p className="text-muted-foreground text-xs">
                            Run this in your terminal:
                          </p>
                          <TryDemoCommand command={installCommand} />
                          <div className="text-muted-foreground space-y-1 text-xs">
                            <p>Then complete setup:</p>
                            <ol className="list-inside list-decimal space-y-0.5 pl-1">
                              <li>
                                <code className="bg-muted rounded px-1 py-0.5 text-[10px]">
                                  cd nanoclaw
                                </code>
                              </li>
                              <li>
                                <code className="bg-muted rounded px-1 py-0.5 text-[10px]">
                                  claude
                                </code>
                              </li>
                              <li>
                                Type{" "}
                                <code className="bg-muted rounded px-1 py-0.5 text-[10px]">
                                  /setup
                                </code>{" "}
                                and follow the prompts
                              </li>
                            </ol>
                          </div>
                        </>
                      )}

                      {installMode === "migrate" && migrateCommand && (
                        <>
                          <p className="text-muted-foreground text-xs">
                            Already running OneCLI locally? Migrate to cloud:
                          </p>
                          <TryDemoCommand command={migrateCommand} />
                          <p className="text-muted-foreground text-xs">
                            This updates your CLI config, NanoClaw .env, and
                            restarts the service. Secrets and app connections
                            need to be re-added in the dashboard.
                          </p>
                        </>
                      )}
                    </>
                  ) : IS_CLOUD ? (
                    <div className="flex items-center justify-center py-6">
                      <Loader2 className="text-muted-foreground size-4 animate-spin" />
                    </div>
                  ) : (
                    <div className="rounded-lg border p-4">
                      <p className="text-sm">
                        One-command install is available with{" "}
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

              {activeSection === "gateway" && (
                <div className="space-y-3">
                  {demoInfo ? (
                    <>
                      <p className="text-muted-foreground text-xs">
                        Run this curl command - it sends a fake token through
                        the gateway:
                      </p>
                      <TryDemoCommand
                        command={demoCommand}
                        highlight="FAKE_TOKEN"
                      />
                      <pre className="bg-muted rounded-lg border p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
                        <span className="text-muted-foreground">
                          {'{\n  ...\n  "headers": {\n    '}
                        </span>
                        <span className="text-muted-foreground line-through">
                          {'"Authorization": "Bearer FAKE_TOKEN"'}
                        </span>
                        {"\n    "}
                        <span className="text-brand font-semibold">
                          {
                            '"Authorization": "Bearer WELCOME-TO-ONECLI-SECRETS-ARE-WORKING"'
                          }
                        </span>
                        <span className="text-muted-foreground">
                          {"\n    ...\n  }\n}"}
                        </span>
                      </pre>
                      <p className="text-muted-foreground text-xs">
                        You sent <code className="text-[10px]">FAKE_TOKEN</code>{" "}
                        - OneCLI replaced it with the real secret.
                      </p>
                    </>
                  ) : (
                    <div className="flex flex-col items-center gap-3 rounded-lg border py-6">
                      <p className="text-muted-foreground text-xs">
                        A demo secret is needed to try this.
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleSeedDemo}
                        loading={seeding}
                      >
                        {seeding ? "Creating..." : "Create demo secret"}
                      </Button>
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
