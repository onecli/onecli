"use client";

import { useState, useEffect } from "react";
import { RefreshCw, Eye, EyeOff, Copy, Check } from "lucide-react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { Button } from "@onecli/ui/components/button";
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
import { useAuth } from "@/providers/auth-provider";
import { getDefaultAgent, regenerateAgentToken } from "@/lib/actions/agents";

export const DefaultAgentCard = () => {
  const { user: authUser } = useAuth();
  const [token, setToken] = useState("");
  const [agentId, setAgentId] = useState("");
  const [loading, setLoading] = useState(true);
  const [revealed, setRevealed] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const { copied, copy } = useCopyToClipboard();

  useEffect(() => {
    if (!authUser?.id) return;
    getDefaultAgent(authUser.id).then((agent) => {
      if (agent) {
        setToken(agent.accessToken);
        setAgentId(agent.id);
      }
      setLoading(false);
    });
  }, [authUser?.id]);

  const truncatedToken = token
    ? `${token.slice(0, 8)}${"•".repeat(12)}${token.slice(-4)}`
    : "";

  const handleRegenerate = async () => {
    if (!authUser?.id || !agentId) return;
    setRegenerating(true);
    try {
      const result = await regenerateAgentToken(agentId, authUser.id);
      setToken(result.accessToken);
      setRevealed(true);
      toast.success("Agent token regenerated");
    } catch {
      toast.error("Failed to regenerate token");
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Agent Token</CardTitle>
        <CardDescription>
          Use this token to authenticate your agent with the proxy.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2">
          <code className="bg-muted flex-1 rounded-md border px-3 py-2 font-mono text-sm select-none">
            {loading ? (
              <span className="text-muted-foreground">Loading...</span>
            ) : !token ? (
              <span className="text-muted-foreground">No token yet</span>
            ) : revealed ? (
              token
            ) : (
              truncatedToken
            )}
          </code>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setRevealed(!revealed)}
            disabled={!token}
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
            onClick={() => copy(token)}
            disabled={!token}
          >
            {copied ? (
              <Check className="size-4 text-green-500" />
            ) : (
              <Copy className="size-4" />
            )}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                disabled={regenerating || !token}
              >
                <RefreshCw
                  className={`size-4 ${regenerating ? "animate-spin" : ""}`}
                />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Regenerate token?</AlertDialogTitle>
                <AlertDialogDescription>
                  The current token will be invalidated immediately. Any CLI
                  sessions or agents using the old token will lose access.
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
      </CardContent>
    </Card>
  );
};
