import { describe, expect, it } from "vitest";
import type { TurnStopReason } from "@1jehuang/jcode-sdk";
import { readJcodeTurnStopped } from "./jcode-turn-stopped";

/** jcode's two sentences, as `provider_guardrail_notice` writes them in the
 * pinned runtime: what rides the frame's `message`. */
const REFUSAL_NOTICE =
  "Provider guardrail stopped the response (stop_reason: refusal). The model declined to answer this request.";
const EMPTY_NOTICE =
  "The model ended its turn without any visible output (stop_reason: end_turn). The provider returned an empty response.";

describe("readJcodeTurnStopped", () => {
  it.each(["refusal", "content_filter", "safety", "REFUSAL", " refusal "])(
    "reads the safety stop %j as a refusal",
    (stopReason) => {
      expect(
        readJcodeTurnStopped({
          reason: "provider_guardrail",
          message: REFUSAL_NOTICE,
          provider_stop_reason: stopReason,
        })?.code,
      ).toBe("model_refused");
    },
  );

  it.each(["guardrail_intervened", "policy_violation_detected"])(
    "reads the guardrail family %j as a refusal (jcode's own rule)",
    (stopReason) => {
      expect(
        readJcodeTurnStopped({
          reason: "provider_guardrail",
          message: "stopped",
          provider_stop_reason: stopReason,
        })?.code,
      ).toBe("model_refused");
    },
  );

  it.each([["end_turn"], ["stop"], [undefined], [""]])(
    "reads a no-output end with stop reason %j as an empty response, never a refusal",
    (stopReason) => {
      // jcode emits the same `provider_guardrail` reason for an empty
      // response; calling it a refusal would blame content for an upstream
      // hiccup and send the person to rephrase instead of resend.
      expect(
        readJcodeTurnStopped({
          reason: "provider_guardrail",
          message: EMPTY_NOTICE,
          ...(stopReason !== undefined && { provider_stop_reason: stopReason }),
        })?.code,
      ).toBe("model_empty_response");
    },
  );

  it.each<TurnStopReason>([
    "interrupted",
    "failure",
    "crash",
    "limit_reached",
    "unknown",
  ])("ignores the %j stop: those outcomes keep their own paths", (reason) => {
    expect(
      readJcodeTurnStopped({
        reason,
        message: "The turn stopped.",
        provider_stop_reason: "refusal",
      }),
    ).toBeNull();
  });

  it("keeps jcode's explanation as the message, unchanged when it names the stop reason", () => {
    expect(
      readJcodeTurnStopped({
        reason: "provider_guardrail",
        message: REFUSAL_NOTICE,
        provider_stop_reason: "refusal",
      }),
    ).toEqual({
      type: "turn.unanswered",
      code: "model_refused",
      message: REFUSAL_NOTICE,
    });
  });

  it("appends the provider's stop reason when the message does not carry it", () => {
    expect(
      readJcodeTurnStopped({
        reason: "provider_guardrail",
        message: "Provider refused",
        provider_stop_reason: "content_filter",
      })?.message,
    ).toBe("Provider refused (stop_reason: content_filter)");
  });

  it("never yields an empty message, and bounds a runaway one", () => {
    expect(
      readJcodeTurnStopped({ reason: "provider_guardrail", message: "  " })
        ?.message,
    ).toBe("The model ended its turn without any output.");
    expect(
      readJcodeTurnStopped({
        reason: "provider_guardrail",
        message: "x".repeat(5_000),
      })?.message.length,
    ).toBe(1_000);
    // The stop reason is relayed provider text too: a runaway one is cut by
    // the same bound, and it never decides the class by accident.
    const huge = readJcodeTurnStopped({
      reason: "provider_guardrail",
      message: "stopped",
      provider_stop_reason: "y".repeat(5_000),
    });
    expect(huge?.message.length).toBe(1_000);
    expect(huge?.code).toBe("model_empty_response");
  });
});
