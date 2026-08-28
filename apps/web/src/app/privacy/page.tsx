import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { IS_CLOUD } from "@/lib/env";

export const metadata: Metadata = {
  // Bare title — the root layout's template appends the brand.
  title: "Privacy Policy",
  description: "How OneCLI collects, uses, and protects your data.",
};

/**
 * The public privacy policy page — a Slack Marketplace listing (and most
 * OAuth app reviews) requires a stable privacy policy URL. Static text on
 * the app origin, no auth, no client JS.
 *
 * HOSTED ONLY: this is OneCLI-the-company's first-party legal claim, which
 * must never render on a self-host's origin as the OPERATOR's policy (wrong
 * data controller, wrong support inbox). Self-hosters listing their own
 * shared app publish their own pages.
 */
export default function PrivacyPage() {
  if (!IS_CLOUD) notFound();
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-3xl font-semibold">Privacy Policy</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        Last updated: August 23, 2026
      </p>

      <div className="mt-8 space-y-8 text-sm leading-6">
        <section className="space-y-2">
          <h2 className="text-lg font-medium">What we collect</h2>
          <p>
            OneCLI collects the information you give us when you create an
            account: your name, email address, and organization details. When
            you connect an integration such as Slack, we store the OAuth tokens
            needed to operate that integration on your behalf.
          </p>
          <p>
            When a teammate messages the OneCLI Slack app, we read their Slack
            display name and Slack-verified email address for one purpose: to
            send them a sign-in or invitation link for your organization. We do
            not read channel history beyond the messages addressed to the app.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-medium">How we use it</h2>
          <p>
            Data is used to provide the OneCLI service: running your agents,
            delivering their messages, and managing your organization. We do not
            sell your data or use it for advertising.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-medium">How we protect it</h2>
          <p>
            All traffic is encrypted in transit with TLS. Integration tokens and
            credentials are encrypted at rest. Access to production systems is
            restricted to authorized personnel.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-medium">Retention and deletion</h2>
          <p>
            We keep your data while your account is active. Uninstalling the
            Slack app deletes the stored workspace installation and its tokens.
            You can request deletion of your account and associated data at any
            time by contacting support.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-medium">Contact</h2>
          <p>
            Questions about this policy: email{" "}
            <a
              href="mailto:support@onecli.sh"
              className="text-brand underline underline-offset-4"
            >
              support@onecli.sh
            </a>
            .
          </p>
        </section>
      </div>
    </main>
  );
}
