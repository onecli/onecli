"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
import { BitwardenSetup } from "../../_components/bitwarden-setup";
import { withProjectPrefix } from "@/lib/navigation";

export default function BitwardenPage() {
  const pathname = usePathname();
  return (
    <div className="space-y-6">
      <Link
        href={withProjectPrefix(pathname, "/connections/vaults")}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="size-4" />
        Vaults
      </Link>
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">Bitwarden</h1>
          <Badge
            variant="secondary"
            className="text-[10px] font-normal px-1.5 py-0"
          >
            Beta
          </Badge>
        </div>
        <p className="text-muted-foreground text-sm">
          Fetch credentials on-demand from your Bitwarden vault — nothing is
          stored on the server.
        </p>
      </div>

      <BitwardenSetup />
    </div>
  );
}
