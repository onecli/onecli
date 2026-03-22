"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Button } from "@onecli/ui/components/button";
import { getDemoInfo } from "@/lib/actions/secrets";
import { TryDemoCommand } from "./try-demo-command";

interface TryDemoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const TryDemoDialog = ({ open, onOpenChange }: TryDemoDialogProps) => {
  const [demoInfo, setDemoInfo] = useState<{
    agentToken: string;
    gatewayUrl: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    getDemoInfo()
      .then((info) => setDemoInfo(info))
      .finally(() => setLoading(false));
  }, [open]);

  const command = demoInfo
    ? `curl -k -x http://x:${demoInfo.agentToken}@${demoInfo.gatewayUrl} -H "Authorization: Bearer FAKE_TOKEN" https://httpbin.org/anything`
    : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Try OneCLI in 30 Seconds</DialogTitle>
          <DialogDescription>
            Run a request and see secret injection in action.
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="text-muted-foreground size-5 animate-spin" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <p className="text-sm font-medium">
                <span className="bg-foreground text-background mr-2 inline-flex size-5 items-center justify-center rounded-full text-xs font-semibold">
                  1
                </span>
                Copy and run this in your terminal
              </p>
              <TryDemoCommand command={command} highlight="FAKE_TOKEN" />
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium">
                <span className="bg-foreground text-background mr-2 inline-flex size-5 items-center justify-center rounded-full text-xs font-semibold">
                  2
                </span>
                Check the response
              </p>
              <pre className="bg-muted rounded-md border p-3 font-mono text-xs whitespace-pre-wrap break-all">
                <span className="text-muted-foreground">
                  {'{\n  ...\n  "headers": {\n    '}
                </span>
                <span className="text-muted-foreground line-through">
                  {'"Authorization": "Bearer FAKE_TOKEN"'}
                </span>
                {"\n    "}
                <span className="text-green-600 dark:text-green-400 font-semibold">
                  {
                    '"Authorization": "Bearer WELCOME-TO-ONECLI-SECRETS-ARE-WORKING"'
                  }
                </span>
                <span className="text-muted-foreground">
                  {"\n    ...\n  }\n}"}
                </span>
              </pre>
              <p className="text-muted-foreground text-sm">
                You sent <code className="text-xs">FAKE_TOKEN</code> - OneCLI
                replaced it with the real secret.
              </p>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
