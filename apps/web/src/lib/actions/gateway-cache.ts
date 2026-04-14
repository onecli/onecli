"use server";

import { db } from "@onecli/db";
import { cookies } from "next/headers";
import { API_URL } from "@/lib/env";
import { resolveUser } from "@/lib/actions/resolve-user";

/**
 * Invalidate the gateway's CONNECT response cache for the current account.
 *
 * Runs server-side so it can authenticate with the gateway properly.
 * Tries API key auth first (works in all auth modes), falls back to
 * forwarding session cookies (works in oauth mode).
 */
export const invalidateGatewayCache = async () => {
  try {
    const headers: Record<string, string> = {};

    // Prefer API key auth — works regardless of gateway auth mode
    const { accountId } = await resolveUser();
    const apiKey = await db.apiKey.findFirst({
      where: { accountId },
      select: { key: true },
    });

    if (apiKey) {
      headers["authorization"] = `Bearer ${apiKey.key}`;
    } else {
      // Fallback: forward session cookies (oauth mode only)
      const cookieStore = await cookies();
      headers["cookie"] = cookieStore
        .getAll()
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");
    }

    await fetch(`${API_URL}/api/cache/invalidate`, {
      method: "POST",
      headers,
    });
  } catch {
    // Fire-and-forget — don't break UI if gateway is unreachable
  }
};
