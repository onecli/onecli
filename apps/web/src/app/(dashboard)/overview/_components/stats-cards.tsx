import Link from "next/link";
import {
  Activity,
  ArrowRight,
  Bot,
  Gauge,
  KeyRound,
  Route,
  ShieldCheck,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";

interface StatsCardsProps {
  agentCount: number;
  secretCount: number;
  injections24h: number;
  destinations24h: number;
  activeAgents24h: number;
  successRate24h: number;
  p95LatencyMs24h: number;
  loading?: boolean;
}

export const StatsCards = ({
  agentCount,
  secretCount,
  injections24h,
  destinations24h,
  activeAgents24h,
  successRate24h,
  p95LatencyMs24h,
  loading = false,
}: StatsCardsProps) => (
  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
          <div className="flex items-center justify-between">
            <p className="text-muted-foreground text-xs">Configured agents</p>
            <ArrowRight className="size-3.5 text-muted-foreground/0 transition-all group-hover:text-muted-foreground group-hover:translate-x-0.5" />
          </div>
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
          <div className="flex items-center justify-between">
            <p className="text-muted-foreground text-xs">
              Encrypted credentials
            </p>
            <ArrowRight className="size-3.5 text-muted-foreground/0 transition-all group-hover:text-muted-foreground group-hover:translate-x-0.5" />
          </div>
        </CardContent>
      </Card>
    </Link>

    <Link href="/activity" className="group">
      <Card className="py-4 gap-3 transition-colors hover:border-foreground/20 cursor-pointer">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium">Injections (24h)</CardTitle>
          <Activity className="text-muted-foreground size-4 transition-colors group-hover:text-emerald-500" />
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-7 w-12 mb-1" />
          ) : (
            <div className="text-2xl font-bold">{injections24h}</div>
          )}
          <div className="flex items-center justify-between">
            <p className="text-muted-foreground text-xs">Header mutations applied</p>
            <ArrowRight className="size-3.5 text-muted-foreground/0 transition-all group-hover:text-muted-foreground group-hover:translate-x-0.5" />
          </div>
        </CardContent>
      </Card>
    </Link>

    <Link href="/activity" className="group">
      <Card className="py-4 gap-3 transition-colors hover:border-foreground/20 cursor-pointer">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium">Destinations (24h)</CardTitle>
          <Route className="text-muted-foreground size-4 transition-colors group-hover:text-cyan-500" />
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-7 w-10 mb-1" />
          ) : (
            <div className="text-2xl font-bold">{destinations24h}</div>
          )}
          <div className="flex items-center justify-between">
            <p className="text-muted-foreground text-xs">Distinct active hosts</p>
            <ArrowRight className="size-3.5 text-muted-foreground/0 transition-all group-hover:text-muted-foreground group-hover:translate-x-0.5" />
          </div>
        </CardContent>
      </Card>
    </Link>

    <Link href="/activity" className="group">
      <Card className="py-4 gap-3 transition-colors hover:border-foreground/20 cursor-pointer">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium">Active Clients (24h)</CardTitle>
          <Bot className="text-muted-foreground size-4 transition-colors group-hover:text-indigo-500" />
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-7 w-10 mb-1" />
          ) : (
            <div className="text-2xl font-bold">{activeAgents24h}</div>
          )}
          <div className="flex items-center justify-between">
            <p className="text-muted-foreground text-xs">Agents with runtime events</p>
            <ArrowRight className="size-3.5 text-muted-foreground/0 transition-all group-hover:text-muted-foreground group-hover:translate-x-0.5" />
          </div>
        </CardContent>
      </Card>
    </Link>

    <Link href="/activity" className="group">
      <Card className="py-4 gap-3 transition-colors hover:border-foreground/20 cursor-pointer">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium">Success Rate (24h)</CardTitle>
          <ShieldCheck className="text-muted-foreground size-4 transition-colors group-hover:text-green-500" />
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-7 w-14 mb-1" />
          ) : (
            <div className="text-2xl font-bold">{successRate24h.toFixed(1)}%</div>
          )}
          <div className="flex items-center justify-between">
            <p className="text-muted-foreground text-xs">Requests without runtime errors</p>
            <ArrowRight className="size-3.5 text-muted-foreground/0 transition-all group-hover:text-muted-foreground group-hover:translate-x-0.5" />
          </div>
        </CardContent>
      </Card>
    </Link>

    <Link href="/activity" className="group">
      <Card className="py-4 gap-3 transition-colors hover:border-foreground/20 cursor-pointer">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium">p95 Latency (24h)</CardTitle>
          <Gauge className="text-muted-foreground size-4 transition-colors group-hover:text-orange-500" />
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-7 w-16 mb-1" />
          ) : (
            <div className="text-2xl font-bold">{Math.round(p95LatencyMs24h)}ms</div>
          )}
          <div className="flex items-center justify-between">
            <p className="text-muted-foreground text-xs">95th percentile request time</p>
            <ArrowRight className="size-3.5 text-muted-foreground/0 transition-all group-hover:text-muted-foreground group-hover:translate-x-0.5" />
          </div>
        </CardContent>
      </Card>
    </Link>
  </div>
);
