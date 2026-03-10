import Link from "next/link";
import { Activity, Zap, Bot, KeyRound, ShieldCheck } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";

interface StatsCardsProps {
  totalActions: number;
  recentActions: number;
  serviceCount: number;
  agentCount: number;
  secretCount: number;
  policyCount: number;
  loading?: boolean;
}

export function StatsCards({
  totalActions,
  recentActions,
  serviceCount,
  agentCount,
  secretCount,
  policyCount,
  loading = false,
}: StatsCardsProps) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <Link href="/agents" className="group">
          <Card className="py-4 gap-3 transition-colors hover:border-foreground/20 cursor-pointer">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Agents</CardTitle>
              <Bot className="text-muted-foreground size-4 transition-colors group-hover:text-blue-500" />
            </CardHeader>
            <CardContent>
              {loading ? (
                <Skeleton className="h-7 w-8 mb-1" />
              ) : (
                <div className="text-2xl font-bold">{agentCount}</div>
              )}
              <p className="text-muted-foreground text-xs">Configured agents</p>
            </CardContent>
          </Card>
        </Link>

        <Link href="/secrets" className="group">
          <Card className="py-4 gap-3 transition-colors hover:border-foreground/20 cursor-pointer">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Secrets</CardTitle>
              <KeyRound className="text-muted-foreground size-4 transition-colors group-hover:text-amber-500" />
            </CardHeader>
            <CardContent>
              {loading ? (
                <Skeleton className="h-7 w-8 mb-1" />
              ) : (
                <div className="text-2xl font-bold">{secretCount}</div>
              )}
              <p className="text-muted-foreground text-xs">
                Encrypted credentials
              </p>
            </CardContent>
          </Card>
        </Link>

        <Link href="/policies" className="group">
          <Card className="py-4 gap-3 transition-colors hover:border-foreground/20 cursor-pointer">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Policies</CardTitle>
              <ShieldCheck className="text-muted-foreground size-4 transition-colors group-hover:text-emerald-500" />
            </CardHeader>
            <CardContent>
              {loading ? (
                <Skeleton className="h-7 w-8 mb-1" />
              ) : (
                <div className="text-2xl font-bold">{policyCount}</div>
              )}
              <p className="text-muted-foreground text-xs">Active policies</p>
            </CardContent>
          </Card>
        </Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card className="py-4 gap-3">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Total Actions</CardTitle>
            <Activity className="text-muted-foreground size-4" />
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-7 w-12 mb-1" />
            ) : (
              <div className="text-2xl font-bold">{totalActions}</div>
            )}
            <p className="text-muted-foreground text-xs">All time</p>
          </CardContent>
        </Card>

        <Card className="py-4 gap-3">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Last 30 Days</CardTitle>
            <Zap className="text-muted-foreground size-4" />
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-7 w-12 mb-1" />
            ) : (
              <div className="text-2xl font-bold">{recentActions}</div>
            )}
            {loading ? (
              <Skeleton className="h-3 w-24" />
            ) : (
              <p className="text-muted-foreground text-xs">
                Across {serviceCount}{" "}
                {serviceCount === 1 ? "service" : "services"}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
