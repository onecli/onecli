"use client";

import { useState, useEffect } from "react";
import { RefreshCw, Eye, EyeOff, Copy, Check, Info } from "lucide-react";
import { toast } from "sonner";
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
  getOrgApiKey,
  regenerateOrgApiKey,
} from "@/lib/settings/org-api-key-actions";

export const OrgApiKeyCard = () => {
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const { copied, copy } = useCopyToClipboard();

  // The action provisions the key on read, so a successful load always returns
  // one — no "generate it yourself" empty state. A failure is a real error, not
  // an absent key.
  useEffect(() => {
    getOrgApiKey()
      .then((result) => setApiKey(result.apiKey ?? ""))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  const truncatedKey = apiKey
    ? `${apiKey.slice(0, 10)}${"•".repeat(12)}${apiKey.slice(-4)}`
    : "";

  const handleRegenerate = async () => {
    setRegenerating(true);
    try {
      const result = await regenerateOrgApiKey();
      setApiKey(result.apiKey);
      setError(false);
      setRevealed(true);
      toast.success("Organization API key regenerated");
    } catch {
      toast.error("Failed to regenerate organization API key");
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your Organization API Key</CardTitle>
        <CardDescription>
          Your personal organization-level key. It works across every workspace
          in this organization. Pass the target workspace with an{" "}
          <code className="bg-muted rounded px-1 py-0.5 text-xs">
            X-Workspace-Id
          </code>{" "}
          header.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          {loading ? (
            <Skeleton className="h-9 flex-1 rounded-md" />
          ) : (
            <code className="bg-muted min-w-0 flex-1 truncate rounded-md border px-3 py-2 font-mono text-sm select-none">
              {error ? (
                <span className="text-muted-foreground">
                  Failed to load API key
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
            onClick={() => setRevealed(!revealed)}
            disabled={loading || !apiKey}
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
            onClick={() => copy(apiKey)}
            disabled={loading || !apiKey}
          >
            {copied ? (
              <Check className="size-4 text-brand" />
            ) : (
              <Copy className="size-4" />
            )}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                disabled={loading || regenerating}
              >
                <RefreshCw
                  className={`size-4 ${regenerating ? "animate-spin" : ""}`}
                />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  Regenerate organization API key?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  The current API key will be invalidated immediately. Any
                  services using the old key will lose access.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleRegenerate}
                  disabled={regenerating}
                >
                  {regenerating ? "Regenerating..." : "Regenerate"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        <div className="text-muted-foreground flex items-start gap-2 text-xs">
          <Info className="mt-0.5 size-3 shrink-0" />
          <span>
            Use with{" "}
            <code className="bg-muted rounded px-1 py-0.5">
              Authorization: Bearer oc_org_...
            </code>{" "}
            and{" "}
            <code className="bg-muted rounded px-1 py-0.5">
              X-Workspace-Id: &lt;workspace-id&gt;
            </code>{" "}
            headers.
          </span>
        </div>
      </CardContent>
    </Card>
  );
};
