"use client";

import { IS_CLOUD } from "@/lib/env";
import { RequestAppSlot as CloudRequestAppSlot } from "@/ee/apps/request-app-slot";
import { LocalRequestAppSlot } from "@/lib/components/request-app-slot-local";

/**
 * Edition dispatcher for the "Request an app" slot, rendered as the first
 * item in the Apps grid: cloud opens an in-app dialog that collects the
 * request, emails the user an acknowledgment via Resend, and pings Discord;
 * other editions link to the OSS repo's GitHub issue form instead (the
 * Resend/Discord plumbing isn't configured there, so the in-app promise
 * would be false).
 *
 * Accepts optional controlled props so the parent can open the dialog
 * programmatically (e.g., via `?request=` URL param from the gateway).
 * The non-cloud arm ignores them — it has no dialog.
 */

export interface RequestAppSlotProps {
  requestOpen?: boolean;
  onRequestOpenChange?: (open: boolean) => void;
  initialName?: string;
  initialUrl?: string;
}

export const RequestAppSlot = (props: RequestAppSlotProps = {}) =>
  IS_CLOUD ? (
    <CloudRequestAppSlot {...props} />
  ) : (
    <LocalRequestAppSlot {...props} />
  );
