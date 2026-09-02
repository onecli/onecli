"use client";

import type { OrgDomain } from "@/lib/api";
import { CopyableValue } from "./copyable-value";

const txtValue = (domain: OrgDomain) =>
  `onecli-verification=${domain.verificationToken}`;

export const DomainTxtRecord = ({ domain }: { domain: OrgDomain }) => {
  return (
    <div className="bg-muted/50 space-y-2 rounded-md p-3 text-xs">
      <p className="text-muted-foreground">
        Add this TXT record at your DNS provider, then click Verify. Changes can
        take a few minutes to propagate.
      </p>
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1">
        <span className="text-muted-foreground">Type</span>
        <span className="font-mono">TXT</span>
        <span className="text-muted-foreground">Host</span>
        <span className="font-mono">@ ({domain.domain})</span>
        <span className="text-muted-foreground">Value</span>
        <CopyableValue
          value={txtValue(domain)}
          copyLabel="Copy TXT record value"
        />
      </div>
    </div>
  );
};
