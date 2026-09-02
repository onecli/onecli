"use client";

import { useState } from "react";

const ONECLI_AWS_ACCOUNT_ID =
  process.env.NEXT_PUBLIC_ONECLI_AWS_ACCOUNT_ID ?? "YOUR_ACCOUNT_ID";

const CopyableField = ({
  label,
  value,
  loading,
  failed,
}: {
  label: string;
  value: string | null;
  loading?: boolean;
  failed?: boolean;
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <button
        type="button"
        onClick={handleCopy}
        disabled={!value}
        // The visible text is the VALUE, which says nothing about what the
        // control does — so name the action for screen readers explicitly.
        aria-label={`Copy ${label}`}
        className="group relative flex w-full items-center rounded-md border bg-card px-3 py-2 text-left font-mono text-xs transition-colors hover:border-foreground/20 disabled:opacity-50"
      >
        <span className="min-w-0 flex-1 truncate">
          {loading ? (
            <span className="text-muted-foreground">Loading...</span>
          ) : failed || !value ? (
            // Never render an empty box: a blank field reads as a broken page
            // and leaves the user with nothing to act on.
            <span className="text-muted-foreground">Unavailable</span>
          ) : (
            value
          )}
        </span>
        <span className="ml-2 shrink-0 text-[10px] text-muted-foreground transition-colors group-hover:text-foreground">
          {copied ? (
            <svg
              viewBox="0 0 16 16"
              fill="currentColor"
              aria-hidden="true"
              className="size-3.5 text-green-500"
            >
              <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
            </svg>
          ) : (
            <svg
              viewBox="0 0 16 16"
              fill="currentColor"
              aria-hidden="true"
              className="size-3.5"
            >
              <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z" />
              <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z" />
            </svg>
          )}
        </span>
      </button>
      {/* The check icon is the only "it copied" signal, and an icon swap is
          invisible to a screen reader — announce it politely instead. */}
      <span aria-live="polite" className="sr-only">
        {copied ? `${label} copied` : ""}
      </span>
    </div>
  );
};

interface AwsTrustPolicyInfoProps {
  externalId: string | null;
  loading: boolean;
  /** The external-ID read failed — say so instead of showing an empty box. */
  failed?: boolean;
}

export const AwsTrustPolicyInfo = ({
  externalId,
  loading,
  failed,
}: AwsTrustPolicyInfoProps) => (
  <>
    <div className="rounded-lg border border-dashed bg-muted/20 px-4 py-3.5 space-y-3">
      <div className="flex items-center gap-2">
        <div className="flex size-5 items-center justify-center rounded-full bg-muted text-[10px] font-bold text-muted-foreground">
          1
        </div>
        <span className="text-xs font-medium">
          Use these in your IAM role&apos;s trust policy
        </span>
      </div>
      <div className="space-y-2 pl-7">
        <CopyableField
          label="OneCLI Account ID"
          value={ONECLI_AWS_ACCOUNT_ID}
        />
        <CopyableField
          label="External ID"
          value={externalId}
          loading={loading}
          failed={failed}
        />
      </div>
      {failed && (
        <p className="pl-7 text-[11px] text-muted-foreground">
          Could not load your organization&apos;s external ID. Close this window
          and try again, or ask an organization admin.
        </p>
      )}
    </div>

    <div className="flex items-center gap-3">
      <div className="bg-border h-px flex-1" />
      <div className="flex items-center gap-2">
        <div className="flex size-5 items-center justify-center rounded-full bg-muted text-[10px] font-bold text-muted-foreground">
          2
        </div>
        <span className="text-muted-foreground/60 text-[10px] uppercase tracking-widest">
          Connect
        </span>
      </div>
      <div className="bg-border h-px flex-1" />
    </div>
  </>
);
