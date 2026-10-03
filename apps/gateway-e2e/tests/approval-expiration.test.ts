import { describe, expect } from "vitest";
import { decideApproval, waitForApproval } from "../src/control.js";
import { startHeldRequest } from "../src/proxy.js";
import { scenario } from "../src/scenario.js";

// Exercises the shipped 180-second deadline, not a shortened test-only timer.
// Opt in with E2E_APPROVAL_EXPIRATION=1 to avoid adding three minutes to every run.
describe.skipIf(process.env.E2E_APPROVAL_EXPIRATION !== "1")(
  "manual approval expiration",
  { timeout: 240_000 },
  () => {
    for (const backend of ["redis", "in-memory"] as const) {
      scenario(
        `${backend}: expires without a reviewer decision and permits fresh approval`,
        async (cx) => {
          const upstream = await cx.upstream();
          await cx.seed({
            withApiKey: true,
            rules: [
              {
                name: "needs-approval",
                action: "allow",
                requireApproval: true,
                targets: [{ hostPattern: "127.0.0.1" }],
              },
            ],
          });
          const gw = await cx.startGateway(
            backend === "in-memory" ? { env: { REDIS_HOST: "" } } : {},
          );
          const request = {
            method: "POST",
            url: upstream.url("/v1/send"),
            token: cx.ids.agentToken,
            body: JSON.stringify({ text: "Review me" }),
            timeoutMs: 210_000,
          };
          const startedAt = performance.now();
          const held = await startHeldRequest(gw.origin, request, 300);
          const original = await waitForApproval(gw, cx.ids.apiKey);
          const expired = await held.response;
          // In-memory cleanup uses whole-second Unix timestamps. Allow that
          // rounding, but catch accidental shortening of the shipped deadline.
          expect(performance.now() - startedAt).toBeGreaterThanOrEqual(179_000);
          expect(expired.status).toBe(403);
          expect(expired.header("x-should-retry")).toBe("false");
          expect(expired.json()).toMatchObject({
            error: "manual_approval_denied",
            reason: "expired",
            approval_id: original.id,
            message: expect.stringContaining("expired without approval"),
          });
          expect(upstream.requests()).toHaveLength(0);
          const stale = await decideApproval(
            gw,
            cx.ids.apiKey,
            original.id,
            "approve",
          );
          expect(stale.status).toBe(404);
          const again = await startHeldRequest(gw.origin, request, 300);
          const fresh = await waitForApproval(gw, cx.ids.apiKey);
          expect(fresh.id).not.toBe(original.id);
          expect(upstream.requests()).toHaveLength(0);
          await decideApproval(gw, cx.ids.apiKey, fresh.id, "approve");
          expect((await again.response).status).toBe(200);
          const seen = await upstream.waitForRequests(1);
          expect(seen).toHaveLength(1);
          expect(seen[0]?.body).toBe(request.body);
        },
      );
    }
  },
);
