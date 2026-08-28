"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import {
  useFinishSharedInstall,
  useInspectSharedInstall,
} from "@/hooks/use-org-channels";

/**
 * The signed-in arm: spend the parked code against the NAMED org — in two
 * steps, so the confirmation names BOTH ends.
 *
 * ⚠️ THE CONFIRMATION IS A SECURITY CONTROL, NOT A COURTESY. Binding on mount
 * would be OAuth login CSRF: the code rides the URL, so anyone could mail an
 * admin `/slack/installed?code=<code from the ATTACKER's own install>` and
 * silently bind the attacker's Slack workspace to the victim's organization —
 * whereupon the onboarding bot mints invitations INTO that org for anyone who
 * DMs it from the attacker's workspace. The dashboard-initiated flow is
 * immune because its signed `state` names the org; this path has no state to
 * verify (that is the whole point of it), so the human is the check. And a
 * human check is only informed if it can name the SOURCE workspace — which
 * lives inside the unexchanged code. So the page first INSPECTS: the server
 * exchanges the code (binding nothing) and answers with the workspace name
 * plus a sealed claim bound to this org and actor. The confirmation then
 * reads "connect workspace X to org Y", and only the confirmed claim binds.
 *
 * The bind target travels as an explicit X-Organization-Id scope (this page's
 * URL carries no org for the client to derive one from); the server re-fences
 * it against the caller's active memberships and the admin gate — the header
 * is a scope, never an authority.
 */
export const SlackInstalledFinish = ({
  code,
  organization,
}: {
  code: string;
  organization: { id: string; name: string } | null;
}) => {
  const router = useRouter();
  const inspect = useInspectSharedInstall();
  const finish = useFinishSharedInstall();
  const [error, setError] = useState<string | null>(null);

  // One-shot: the inspect EXCHANGES the single-use code (outrunning its
  // ten-minute expiry), so it must never re-fire — strict-mode remounts
  // included. A mutation, not a query: it burns state server-side.
  const inspected = useRef(false);
  const organizationId = organization?.id;
  const inspectMutate = inspect.mutate;
  useEffect(() => {
    if (!organizationId || inspected.current) return;
    inspected.current = true;
    inspectMutate({ provider: "slack", code, organizationId });
  }, [organizationId, code, inspectMutate]);

  // Signed in but org-less (a brand-new account mid-onboarding): a Connect
  // click would be refused server-side, so offer the way forward instead of
  // a doomed button. The parked install can be finished from Slack again
  // once the org exists.
  if (!organization) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center px-4">
        <Card className="w-full max-w-md p-8 text-center">
          <h1 className="text-sm font-medium">
            Finish setting up OneCLI first
          </h1>
          <p className="text-muted-foreground mt-2 text-sm">
            Your account has no organization yet. Complete your OneCLI setup,
            then install the Slack app again from Slack.
          </p>
          <Button className="mt-6" onClick={() => router.replace("/")}>
            Go to OneCLI
          </Button>
        </Card>
      </div>
    );
  }

  if (inspect.isError) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center px-4">
        <Card className="w-full max-w-md p-8 text-center">
          <h1 className="text-sm font-medium">
            This install could not be verified
          </h1>
          <p className="text-muted-foreground mt-2 text-sm" role="alert">
            {inspect.error.message}
          </p>
          <Button
            className="mt-6"
            onClick={() => router.replace(`/org/${organization.id}/channels`)}
          >
            Go to Channels
          </Button>
        </Card>
      </div>
    );
  }

  if (!inspect.data) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center px-4">
        <Card className="w-full max-w-md p-8 text-center">
          <Loader2 className="mx-auto size-5 animate-spin" aria-hidden />
          <p className="text-muted-foreground mt-4 text-sm">
            Checking the Slack install…
          </p>
        </Card>
      </div>
    );
  }

  const workspaceName = inspect.data.team.name ?? inspect.data.team.externalId;

  const connect = () => {
    setError(null);
    finish.mutate(
      {
        provider: "slack",
        claim: inspect.data.claim,
        organizationId: organization.id,
      },
      {
        onSuccess: ({ organizationId: boundTo }) => {
          router.replace(`/org/${boundTo}/channels?connected=slack`);
        },
        onError: (err: Error) => setError(err.message),
      },
    );
  };

  return (
    <div className="flex min-h-svh flex-col items-center justify-center px-4">
      <Card className="w-full max-w-md p-8 text-center">
        <h1 className="text-sm font-medium">Connect this Slack workspace?</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Link the Slack workspace{" "}
          <span className="text-foreground font-medium">{workspaceName}</span>{" "}
          to{" "}
          <span className="text-foreground font-medium">
            {organization.name}
          </span>
          , so your team can sign in from Slack. Only connect a workspace you
          recognize.
        </p>
        {error && (
          <p className="text-destructive mt-4 text-sm" role="alert">
            {error}
          </p>
        )}
        <div className="mt-6 flex items-center justify-center gap-2">
          <Button onClick={connect} loading={finish.isPending}>
            {finish.isPending ? "Connecting…" : "Connect Slack"}
          </Button>
          <Button
            variant="outline"
            disabled={finish.isPending}
            onClick={() => router.replace(`/org/${organization.id}/channels`)}
          >
            Cancel
          </Button>
        </div>
      </Card>
    </div>
  );
};
