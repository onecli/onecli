"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bot, Blocks, Brain, KeyRound, ArrowRight } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { withProjectPrefix } from "@/lib/navigation";

interface StatsCardsProps {
  agentCount: number;
  appCount: number;
  llmCount: number;
  secretCount: number;
  loading?: boolean;
}

export const StatsCards = ({
  agentCount,
  appCount,
  llmCount,
  secretCount,
  loading = false,
}: StatsCardsProps) => {
  const pathname = usePathname();

  const cards = [
    {
      title: "Agents",
      count: agentCount,
      label: "Configured agents",
      href: "/agents",
      icon: Bot,
      hoverColor: "group-hover:text-blue-500",
    },
    {
      title: "Apps",
      count: appCount,
      label: "Connected apps",
      href: "/connections",
      icon: Blocks,
      hoverColor: "group-hover:text-green-500",
    },
    {
      title: "LLMs",
      count: llmCount,
      label: "LLM keys",
      href: "/connections/llms",
      icon: Brain,
      hoverColor: "group-hover:text-purple-500",
    },
    {
      title: "Secrets",
      count: secretCount,
      label: "Encrypted credentials",
      href: "/connections/custom",
      icon: KeyRound,
      hoverColor: "group-hover:text-amber-500",
    },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((card) => (
        <Link
          key={card.title}
          href={withProjectPrefix(pathname, card.href)}
          className="group"
        >
          <Card className="py-4 gap-3 transition-colors hover:border-foreground/20 cursor-pointer">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">
                {card.title}
              </CardTitle>
              <card.icon
                className={`text-muted-foreground size-4 transition-colors ${card.hoverColor}`}
              />
            </CardHeader>
            <CardContent>
              {loading ? (
                <Skeleton className="h-7 w-8 mb-1" />
              ) : (
                <div className="text-2xl font-bold">{card.count}</div>
              )}
              <div className="flex items-center justify-between">
                <p className="text-muted-foreground text-xs">{card.label}</p>
                <ArrowRight className="size-3.5 text-muted-foreground/0 transition-all group-hover:text-muted-foreground group-hover:translate-x-0.5" />
              </div>
            </CardContent>
          </Card>
        </Link>
      ))}
    </div>
  );
};
