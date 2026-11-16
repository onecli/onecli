"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
import { useConnectionsHref } from "@/lib/settings-modal/use-connections-href";

/** The frame shared by the vault provider pages: a link back to the Vaults
 * tab, the provider title with its Beta badge, a description, then the
 * provider's setup flow. Inside the Settings modal the link stays inside
 * it (`?settings=apps&tab=vaults`). */
export const VaultPageFrame = ({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) => {
  const href = useConnectionsHref();
  return (
    <div className="space-y-6">
      <Link
        href={href("/vaults")}
        className="inline-flex h-8 items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="size-4" />
        Vaults
      </Link>
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          <Badge
            variant="secondary"
            className="text-[10px] font-normal px-1.5 py-0"
          >
            Beta
          </Badge>
        </div>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>

      {children}
    </div>
  );
};
