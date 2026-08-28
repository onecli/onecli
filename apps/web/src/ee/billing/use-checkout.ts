"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { BillingInterval, Plan } from "@onecli/api/ee/billing/plans";
import { apiFetch } from "@/lib/api-fetch";

export function useCheckout() {
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) setLoading(false);
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  const checkout = async (plan: Plan, interval: BillingInterval = "month") => {
    setLoading(true);
    try {
      const res = await apiFetch("/v1/billing/checkout", {
        method: "POST",
        body: JSON.stringify({
          plan,
          interval,
          cancelUrl: window.location.href,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to create checkout session");
      }

      if (data.switched) {
        // Plan switch happened server-side, reload to reflect new plan
        window.location.reload();
      } else {
        window.location.href = data.checkout_url;
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to start checkout",
      );
      setLoading(false);
    }
  };

  return { checkout, loading };
}
