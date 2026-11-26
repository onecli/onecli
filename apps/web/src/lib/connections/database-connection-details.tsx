import type { ReactNode } from "react";
import { databaseTlsModeFromTags } from "@onecli/api/lib/connection-display";

export interface DatabaseConnectionDetailsProps {
  tags: string[];
  children?: ReactNode;
}

/** Saved TLS configuration, not a claim that the last live check succeeded. */
export const DatabaseConnectionDetails = ({
  tags,
  children,
}: DatabaseConnectionDetailsProps) => {
  const mode = databaseTlsModeFromTags(tags);
  return (
    <div className="grid grid-cols-1 items-start gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,1fr)_auto]">
      {mode === "disable" && (
        <p
          className="py-2.5 text-xs leading-4 text-amber-700 dark:text-amber-400"
          aria-label="Database encryption settings"
        >
          Not encrypted <span aria-hidden="true">·</span> Queries and results
          can be read and changed on the network
        </p>
      )}
      {(mode === "verify-full" || mode === "require") && (
        <p
          className="text-muted-foreground dark:text-foreground/70 py-2.5 text-xs leading-4"
          aria-label="Database encryption settings"
        >
          Encrypted <span aria-hidden="true">·</span>{" "}
          {mode === "verify-full"
            ? "Certificate verification on"
            : "Certificate verification off"}
        </p>
      )}
      {children}
    </div>
  );
};
