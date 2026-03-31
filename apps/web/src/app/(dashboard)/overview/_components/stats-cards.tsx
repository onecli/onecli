import Link from "next/link";
import { Bot, KeyRound, ArrowRight } from "lucide-react";
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
  loading?: boolean;
}

export const StatsCards = ({
  agentCount,
  secretCount,
  loading = false,
}: StatsCardsProps) => (
  <div className="grid gap-4 sm:grid-cols-2">
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

    <Link href="/connections/secrets" className="group">
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
  </div>
);
