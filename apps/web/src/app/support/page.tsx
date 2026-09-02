import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { IS_CLOUD } from "@/lib/env";

export const metadata: Metadata = {
  // Bare title — the root layout's template appends the brand.
  title: "Support",
  description: "Get help with OneCLI.",
};

/**
 * The public support page — the Slack Marketplace listing requires a
 * stable support URL. Static, no auth.
 *
 * HOSTED ONLY (same law as /privacy): OneCLI's support inbox and SLA must
 * not present as the OPERATOR's on a self-host's origin.
 */
export default function SupportPage() {
  if (!IS_CLOUD) notFound();
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-3xl font-semibold">Support</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        We are happy to help with anything OneCLI.
      </p>

      <div className="mt-8 space-y-8 text-sm leading-6">
        <section className="space-y-2">
          <h2 className="text-lg font-medium">Email</h2>
          <p>
            The fastest way to reach us:{" "}
            <a
              href="mailto:support@onecli.sh"
              className="text-brand underline underline-offset-4"
            >
              support@onecli.sh
            </a>
            . We respond within one business day.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-medium">Slack app</h2>
          <p>
            Trouble with the OneCLI Slack app? Uninstalling and reinstalling it
            from your workspace resolves most connection issues. If a teammate
            is not getting their sign-in link, make sure they have a verified
            email on their Slack profile.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-medium">Documentation</h2>
          <p>
            Guides and reference live at{" "}
            <a
              href="https://onecli.sh/docs"
              className="text-brand underline underline-offset-4"
            >
              onecli.sh/docs
            </a>
            .
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-medium">Privacy</h2>
          <p>
            See our{" "}
            <Link
              href="/privacy"
              className="text-brand underline underline-offset-4"
            >
              privacy policy
            </Link>{" "}
            for how we handle your data.
          </p>
        </section>
      </div>
    </main>
  );
}
