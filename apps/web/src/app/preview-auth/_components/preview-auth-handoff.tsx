"use client";

import { useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";
import { Card } from "@onecli/ui/components/card";
import { usePreviewTicket } from "@/hooks/use-ports";

/**
 * Signed-in arm: trade the preview host for a host-bound ticket URL and go
 * there. The api decides everything (preview exists, viewer is a member of
 * its workspace); the URL it returns always points at the preview host it
 * was asked about, so following it cannot redirect anywhere else.
 */
export const PreviewAuthHandoff = ({
  host,
  path,
}: {
  host: string;
  path: string;
}) => {
  const ticket = usePreviewTicket();
  const started = useRef(false);
  const mutate = ticket.mutate;

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    mutate(
      { host, path },
      {
        onSuccess: ({ url }) => {
          // Belt: only ever follow a URL on the preview host we asked for.
          if (new URL(url).hostname === host) window.location.replace(url);
        },
      },
    );
  }, [host, path, mutate]);

  return (
    <div className="flex min-h-svh items-center justify-center px-4">
      <Card className="w-full max-w-md p-8 text-center">
        {ticket.isError ? (
          <>
            <h1 className="text-sm font-medium">
              Can&apos;t open this preview
            </h1>
            <p className="text-muted-foreground mt-2 text-sm" role="alert">
              {ticket.error.message}
            </p>
          </>
        ) : (
          <>
            <Loader2 className="mx-auto size-5 animate-spin" aria-hidden />
            <p className="text-muted-foreground mt-4 text-sm">
              Opening the preview…
            </p>
          </>
        )}
      </Card>
    </div>
  );
};
