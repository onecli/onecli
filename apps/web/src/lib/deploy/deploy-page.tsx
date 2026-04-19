import { Rocket, ExternalLink } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";

export default function DeployPage() {
  return (
    <div className="mx-auto max-w-lg py-16">
      <Card className="flex flex-col items-center gap-5 p-8 text-center">
        <div className="flex size-14 items-center justify-center rounded-full bg-brand/10">
          <Rocket className="size-7 text-brand" />
        </div>
        <div>
          <h1 className="text-xl font-bold">Launch Agent</h1>
          <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
            Deploy a cloud-hosted AI agent that runs 24/7, connected to
            Telegram, WhatsApp, and more. No infrastructure to manage.
          </p>
        </div>
        <div className="flex flex-col items-center gap-3">
          <Button asChild>
            <a
              href="https://app.onecli.sh/deploy"
              target="_blank"
              rel="noopener noreferrer"
            >
              Get Started on OneCLI Cloud
              <ExternalLink className="size-3.5" />
            </a>
          </Button>
          <p className="text-muted-foreground text-xs">
            Available exclusively on{" "}
            <a
              href="https://onecli.sh"
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground underline underline-offset-2 decoration-foreground/20 hover:decoration-foreground/60 transition-colors"
            >
              OneCLI Cloud
            </a>
          </p>
        </div>
      </Card>
    </div>
  );
}
