"use client";

import { Button } from "@onecli/ui/components/button";
import { CAPS } from "@/lib/env";
import { ViewPlansLink } from "./view-plans-link";

const CLASS = "mt-auto w-full";

/**
 * The locked card's way forward. Where the deployment bills (cloud), the
 * in-product Billing page; on a self-host, which has no billing, a talk
 * with us about an Enterprise license. Only the billing arm reads the URL
 * (the locked card also renders outside the dashboard, on /claim).
 */
export const ViewPlansButton = () =>
  CAPS.billing ? (
    <ViewPlansLink className={CLASS} />
  ) : (
    <Button asChild className={CLASS}>
      <a
        href="https://onecli.sh/contact"
        target="_blank"
        rel="noopener noreferrer"
      >
        Contact us
      </a>
    </Button>
  );
