"use client";

import Image from "next/image";
import type { ReactNode } from "react";
import { Progress } from "@onecli/ui/components/progress";
import { cn } from "@onecli/ui/lib/utils";

interface ConnectLayoutProps {
  appName: string;
  appIcon: string;
  appDarkIcon?: string;
  children: ReactNode;
  variant?: "default" | "success" | "error";
  progress?: number | null;
}

export const ConnectLayout = ({
  appName,
  appIcon,
  appDarkIcon,
  children,
  variant = "default",
  progress = null,
}: ConnectLayoutProps) => {
  return (
    <div className="w-full max-w-md overflow-hidden rounded-2xl border bg-card shadow-lg">
      {/* Header */}
      <div className="relative flex flex-col items-center gap-6 bg-gradient-to-b from-muted/60 to-card px-8 pt-12 pb-8">
        {/* Two logos with animated connector */}
        <div className="flex items-center gap-5">
          <div className="flex size-14 items-center justify-center rounded-2xl border bg-card shadow-sm">
            <Image src="/logo-icon.svg" alt="OneCLI" width={26} height={26} />
          </div>
          <LogoConnector variant={variant} />
          <div className="flex size-14 items-center justify-center rounded-2xl border bg-card shadow-sm">
            {appDarkIcon ? (
              <>
                <Image
                  src={appIcon}
                  alt={appName}
                  width={26}
                  height={26}
                  className="block dark:hidden"
                />
                <Image
                  src={appDarkIcon}
                  alt={appName}
                  width={26}
                  height={26}
                  className="hidden dark:block"
                />
              </>
            ) : (
              <Image src={appIcon} alt={appName} width={26} height={26} />
            )}
          </div>
        </div>

        {/* Title */}
        <h1 className="text-center text-lg font-semibold leading-snug tracking-tight">
          OneCLI wants to connect
          <br />
          to your {appName}
        </h1>
      </div>

      {/* Body */}
      <div className="px-8 pb-8">{children}</div>

      {/* Progress bar */}
      {progress !== null && (
        <Progress
          value={progress}
          className="h-1 rounded-none bg-muted [&>[data-slot=progress-indicator]]:bg-brand/60"
        />
      )}

      {/* Footer */}
      <div className="flex items-center justify-center gap-2 border-t px-8 py-4">
        <Image
          src="/logo-icon.svg"
          alt="OneCLI"
          width={12}
          height={12}
          className="opacity-30"
        />
        <span className="text-[11px] text-muted-foreground/70">
          Secured by OneCLI
        </span>
      </div>
    </div>
  );
};

const LogoConnector = ({ variant }: { variant: string }) => {
  if (variant === "success") {
    return (
      <div className="flex items-center justify-center w-8">
        <div className="flex size-6 items-center justify-center rounded-full bg-brand animate-in zoom-in-50 duration-300">
          <svg
            viewBox="0 0 12 12"
            className="size-3 text-white"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M2 6l3 3 5-5" />
          </svg>
        </div>
      </div>
    );
  }

  if (variant === "error") {
    return (
      <div className="flex items-center justify-center w-8">
        <div className="flex size-6 items-center justify-center rounded-full bg-destructive/10">
          <svg
            viewBox="0 0 12 12"
            className="size-3 text-destructive"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
          >
            <path d="M3 3l6 6M9 3l-6 6" />
          </svg>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 w-8 justify-center">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={cn(
            "size-1 rounded-full bg-muted-foreground/30",
            "animate-pulse",
          )}
          style={{ animationDelay: `${i * 200}ms` }}
        />
      ))}
    </div>
  );
};
