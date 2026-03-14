"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { Code, Moon, Sun } from "lucide-react";
import { SidebarTrigger } from "@onecli/ui/components/sidebar";
import { Separator } from "@onecli/ui/components/separator";
import { Button } from "@onecli/ui/components/button";
import { Badge } from "@onecli/ui/components/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import Link from "next/link";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@onecli/ui/components/breadcrumb";
import { navItems } from "@/lib/nav-items";
import { getSecretsMode } from "@/lib/actions/secrets";
import { useAuth } from "@/providers/auth-provider";
import { TryDemoButton } from "./try-demo-button";

interface SecretsModeStatus {
  mode: "local_db" | "vault_hcp";
  label: string;
  details: string;
  connectionStatus: "connected" | "degraded" | "disconnected" | "not-applicable";
  connectionMessage: string;
}

export const DashboardHeader = () => {
  const pathname = usePathname();
  const { resolvedTheme, setTheme } = useTheme();
  const { user } = useAuth();
  const [secretsMode, setSecretsMode] = useState<SecretsModeStatus | null>(null);

  const navItem = navItems.find((item) => pathname.startsWith(item.url));
  const title = navItem?.title ?? "Dashboard";

  const subPath = navItem
    ? pathname.slice(navItem.url.length).replace(/^\//, "")
    : "";
  const subSegments = subPath ? subPath.split("/") : [];

  const lastSegment = subSegments[subSegments.length - 1];
  const subPageLabel = lastSegment
    ? lastSegment.charAt(0).toUpperCase() + lastSegment.slice(1)
    : null;

  useEffect(() => {
    let cancelled = false;

    const loadSecretsMode = async () => {
      if (!user?.id) return;
      try {
        const result = await getSecretsMode(user.id);
        if (!cancelled) {
          setSecretsMode(result);
        }
      } catch {
        if (!cancelled) {
          setSecretsMode(null);
        }
      }
    };

    loadSecretsMode();

    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  const statusDotClass =
    secretsMode?.connectionStatus === "connected"
      ? "bg-emerald-500"
      : secretsMode?.connectionStatus === "degraded"
        ? "bg-amber-500"
        : secretsMode?.connectionStatus === "disconnected"
          ? "bg-destructive"
          : "bg-muted-foreground";

  const modeLabel = secretsMode
    ? secretsMode.mode === "vault_hcp"
      ? "Vault"
      : "Local DB"
    : "Secrets";

  return (
    <div className="flex w-full items-center gap-2 px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 h-4" />
      <Breadcrumb>
        <BreadcrumbList>
          {subPageLabel ? (
            <>
              <BreadcrumbItem>
                <BreadcrumbLink asChild>
                  <Link href={navItem!.url}>{title}</Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>{subPageLabel}</BreadcrumbPage>
              </BreadcrumbItem>
            </>
          ) : (
            <BreadcrumbItem>
              <BreadcrumbPage>{title}</BreadcrumbPage>
            </BreadcrumbItem>
          )}
        </BreadcrumbList>
      </Breadcrumb>
      <div className="ml-auto flex items-center gap-2">
        {secretsMode && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="secondary" className="hidden gap-1.5 px-2 py-1 text-xs md:inline-flex">
                <span className={`inline-block size-1.5 rounded-full ${statusDotClass}`} />
                {modeLabel}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              <p>
                Secrets mode: {secretsMode.label} · {secretsMode.connectionMessage}
              </p>
            </TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" asChild>
              <a
                href="https://www.onecli.sh/docs/sdks/overview"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Code className="size-3.5" />
                SDKs
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Learn how to connect OneCLI to your agent
          </TooltipContent>
        </Tooltip>
        <TryDemoButton />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={() =>
                setTheme(resolvedTheme === "dark" ? "light" : "dark")
              }
            >
              <Sun className="size-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
              <Moon className="absolute size-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
              <span className="sr-only">Toggle theme</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Toggle theme</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
};
