"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { cn } from "@onecli/ui/lib/utils";
import { useVaultStatus } from "@/hooks/use-vault-status";
import { withProjectPrefix } from "@/lib/navigation";

/** A vault provider rendered as a connect/manage card on the Vaults tab. */
interface VaultProviderMeta {
  provider: string;
  title: string;
  description: string;
  iconSrc: string;
  iconSize: number;
  vaultPath: string;
}

const VAULT_PROVIDERS: VaultProviderMeta[] = [
  {
    provider: "bitwarden",
    title: "Bitwarden",
    description:
      "Access credentials from your Bitwarden vault. The gateway fetches secrets at request time. Nothing is stored.",
    iconSrc: "/icons/bitwarden.svg",
    iconSize: 28,
    vaultPath: "/connections/vaults/bitwarden",
  },
  {
    provider: "onepassword",
    title: "1Password",
    description:
      "Resolve secrets from 1Password with a service account. The gateway fetches them at request time. Nothing is stored.",
    iconSrc: "/icons/onepassword.svg",
    iconSize: 32,
    vaultPath: "/connections/vaults/onepassword",
  },
];

export const VaultsTab = () => (
  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
    {VAULT_PROVIDERS.map((meta) => (
      <VaultProviderCard key={meta.provider} {...meta} />
    ))}
  </div>
);

// Both vault providers share an identical card; only the icon, copy, status
// provider, and manage link differ — so they're driven from VAULT_PROVIDERS
// above rather than duplicated per provider.
const VaultProviderCard = ({
  provider,
  title,
  description,
  iconSrc,
  iconSize,
  vaultPath,
}: VaultProviderMeta) => {
  const pathname = usePathname();
  const { loading, isPaired, isReady, status } = useVaultStatus<{
    last_error: string | null;
  }>(provider);

  if (loading) {
    return (
      <Card className="relative overflow-hidden flex flex-col">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Skeleton className="size-10 rounded-lg" />
              <Skeleton className="h-5 w-24" />
            </div>
            <Skeleton className="h-5 w-20 rounded-full" />
          </div>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="mt-1 h-4 w-3/4" />
          <div className="mt-auto pt-4">
            <Skeleton className="h-8 w-full rounded-md" />
          </div>
        </CardContent>
      </Card>
    );
  }

  const hasError = !!status?.status_data?.last_error;

  return (
    <Card
      className={cn(
        "relative overflow-hidden flex flex-col",
        isPaired && !hasError && "border-brand/30",
        hasError && "border-red-500/30",
      )}
    >
      {isPaired && !hasError && (
        <div className="absolute top-0 left-0 right-0 h-0.5 bg-brand" />
      )}
      {hasError && (
        <div className="absolute top-0 left-0 right-0 h-0.5 bg-red-500" />
      )}
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg">
              <Image
                src={iconSrc}
                alt={title}
                width={iconSize}
                height={iconSize}
              />
            </div>
            <div className="flex items-center gap-2">
              <CardTitle className="text-base">{title}</CardTitle>
              <Badge
                variant="secondary"
                className="text-[10px] font-normal px-1.5 py-0"
              >
                Beta
              </Badge>
            </div>
          </div>
          {isPaired ? (
            <div className="flex items-center gap-1.5">
              <span
                className={cn(
                  "size-2 rounded-full",
                  hasError ? "bg-red-500" : "bg-brand",
                )}
              />
              <span
                className={cn(
                  "text-xs font-medium",
                  hasError ? "text-red-600 dark:text-red-400" : "text-brand",
                )}
              >
                {hasError ? "Error" : isReady ? "Connected" : "Paired"}
              </span>
            </div>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">
        <CardDescription>{description}</CardDescription>
        <div className="mt-auto pt-4">
          <Button
            size="sm"
            variant={isPaired ? "outline" : "default"}
            className="w-full"
            asChild
          >
            <Link href={withProjectPrefix(pathname, vaultPath)}>
              {isPaired ? "Manage" : "Connect"}
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};
