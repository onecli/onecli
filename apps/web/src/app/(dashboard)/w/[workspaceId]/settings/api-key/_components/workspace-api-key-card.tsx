"use client";

import { useState } from "react";
import { RefreshCw, Eye, EyeOff, Copy, Check, Loader2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { Button } from "@onecli/ui/components/button";
import { Skeleton } from "@onecli/ui/components/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@onecli/ui/components/alert-dialog";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import {
  useRegenerateWorkspaceApiKey,
  useWorkspaceApiKey,
} from "@/hooks/use-workspace-api-key";

export const WorkspaceApiKeyCard = () => {
  const { data, isPending, isError } = useWorkspaceApiKey();
  const regenerate = useRegenerateWorkspaceApiKey();
  const [revealed, setRevealed] = useState(false);
  const { copied, copy } = useCopyToClipboard();

  const apiKey = data?.apiKey ?? "";
  const truncatedKey = apiKey
    ? `${apiKey.slice(0, 6)}${"•".repeat(12)}${apiKey.slice(-4)}`
    : "";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your API Key</CardTitle>
        <CardDescription>
          Personal to you and scoped to this workspace. Requests made with it
          are attributed to you. Install uses it in its sign-in command.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2">
          {isPending ? (
            <Skeleton className="h-9 flex-1 rounded-md" />
          ) : (
            <code className="bg-muted min-w-0 flex-1 truncate rounded-md border px-3 py-2 font-mono text-sm select-none">
              {isError || !apiKey ? (
                <span className="text-muted-foreground">
                  Couldn&apos;t load your API key. Reload to try again.
                </span>
              ) : revealed ? (
                apiKey
              ) : (
                truncatedKey
              )}
            </code>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label={revealed ? "Hide API key" : "Reveal API key"}
            onClick={() => setRevealed(!revealed)}
            disabled={isPending || !apiKey}
          >
            {revealed ? (
              <EyeOff className="size-4" />
            ) : (
              <Eye className="size-4" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Copy API key"
            onClick={() => copy(apiKey)}
            disabled={isPending || !apiKey}
          >
            {copied ? (
              <Check className="text-brand size-4" />
            ) : (
              <Copy className="size-4" />
            )}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Regenerate API key"
                disabled={isPending || regenerate.isPending || !apiKey}
              >
                {regenerate.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Regenerate API key?</AlertDialogTitle>
                <AlertDialogDescription>
                  The current API key will be invalidated immediately. Any CLI,
                  SDK, or service using the old key will lose access until you
                  sign it in again with the new one.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                {/* The action closes the dialog on click; the trigger's
                    spinner carries the pending state from there. */}
                <AlertDialogAction
                  onClick={() =>
                    regenerate.mutate(undefined, {
                      onSuccess: () => setRevealed(true),
                    })
                  }
                >
                  Regenerate
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardContent>
    </Card>
  );
};
