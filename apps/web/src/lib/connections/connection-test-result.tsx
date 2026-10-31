import { CircleCheck } from "lucide-react";
import type { ConnectionTestResponse } from "@/lib/api/connection-test";
import { ConnectionTestError } from "@/lib/api/connection-test-error";
import { emphasizeOptions } from "./emphasize-option";
import { SuperuserNotice } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/superuser-notice";

/** PostgreSQL's own guide: `ssl = on` plus a certificate and key. A
 *  self-signed certificate is enough under Encrypt only. */
const ENABLE_SSL_GUIDE =
  "https://www.postgresql.org/docs/current/ssl-tcp.html#SSL-SETUP";

export interface ConnectionTestResultProps {
  pending: boolean;
  result?: ConnectionTestResponse;
  error: Error | null;
  showSuperuser?: boolean;
}

export const ConnectionTestResult = ({
  pending,
  result,
  error,
  showSuperuser = true,
}: ConnectionTestResultProps) => {
  if (pending)
    return (
      <p
        role="status"
        className="text-muted-foreground dark:text-foreground/70 text-xs"
      >
        Checking connection…
      </p>
    );
  if (error) {
    const noTls =
      error instanceof ConnectionTestError && error.code === "SERVER_NO_TLS";
    return (
      <div
        role="alert"
        className={
          noTls
            ? "max-w-prose space-y-0.5 rounded-md border border-amber-500/30 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:bg-amber-500/10 dark:text-amber-300"
            : "max-w-prose space-y-0.5 text-xs leading-relaxed"
        }
      >
        <p className={noTls ? "font-medium" : "text-foreground font-medium"}>
          {noTls ? "SSL is off on this server" : "Could not connect"}
        </p>
        <p
          className={
            noTls
              ? "break-words"
              : "text-muted-foreground dark:text-foreground/70 break-words"
          }
        >
          {noTls ? emphasizeOptions(error.message) : error.message}
        </p>
        {noTls && (
          <a
            href={ENABLE_SSL_GUIDE}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block underline underline-offset-2"
          >
            How to turn on SSL in PostgreSQL
          </a>
        )}
      </div>
    );
  }
  if (!result) return null;
  return (
    <div className="space-y-2">
      <div
        role="status"
        className="flex items-start gap-2 rounded-md border border-emerald-600/25 bg-emerald-50 px-3 py-2 dark:border-emerald-400/25 dark:bg-emerald-500/10"
      >
        <CircleCheck
          className="mt-px size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
          aria-hidden="true"
        />
        <div className="min-w-0 text-xs leading-4">
          <p className="font-medium text-emerald-800 dark:text-emerald-300">
            Connection verified
          </p>
          <p className="text-emerald-700/80 dark:text-emerald-300/70">
            OneCLI logged in to the database successfully.
          </p>
        </div>
      </div>
      {showSuperuser && result.superuser && <SuperuserNotice />}
    </div>
  );
};
