"use client";

import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";
import { useEffect, type ReactNode } from "react";
import { useAuth } from "@/providers/auth-provider";
import { AnalyticsPageview } from "@/ee/analytics-pageview";
import { FathomAnalytics } from "@/ee/fathom";

// Baked at build time by the cloud image (deploy.yml build-args). Unset —
// every self-host build — means analytics never initializes: the provider
// renders its children plain and no identifier ships in the bundle.
const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const POSTHOG_HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST;

const AnalyticsIdentify = () => {
  const { user } = useAuth();

  useEffect(() => {
    if (user) {
      posthog.identify(user.id, {
        email: user.email,
        name: user.name,
      });
    }
  }, [user]);

  return null;
};

export const AnalyticsProvider = ({ children }: { children: ReactNode }) => {
  const enabled = POSTHOG_KEY !== undefined && POSTHOG_HOST !== undefined;

  useEffect(() => {
    if (POSTHOG_KEY === undefined || POSTHOG_HOST === undefined) return;
    posthog.init(POSTHOG_KEY, {
      api_host: POSTHOG_HOST,
      ui_host: "https://us.posthog.com",
      person_profiles: "identified_only",
      capture_pageview: false,
      capture_pageleave: true,
    });
  }, []);

  if (!enabled) return <>{children}</>;

  return (
    <PostHogProvider client={posthog}>
      <AnalyticsIdentify />
      <AnalyticsPageview />
      <FathomAnalytics />
      {children}
    </PostHogProvider>
  );
};
