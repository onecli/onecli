import { describe, expect, it } from "vitest";
import { buildPriceToPlan } from "./price-map";

describe("buildPriceToPlan", () => {
  it("maps configured price ids to plans", () => {
    expect(
      buildPriceToPlan([
        ["price_pro", "pro"],
        ["price_team", "team"],
        ["price_ent", "enterprise"],
      ]),
    ).toEqual({
      price_pro: "pro",
      price_team: "team",
      price_ent: "enterprise",
    });
  });

  it("skips unset ids instead of creating an empty-string key", () => {
    const map = buildPriceToPlan([
      ["price_pro", "pro"],
      ["", "team"],
      ["", "enterprise"],
    ]);
    expect(map).toEqual({ price_pro: "pro" });
    expect(Object.keys(map)).not.toContain("");
    expect(map[""]).toBeUndefined();
  });

  it("resolves many price ids onto one plan (monthly, yearly, hosted, legacy, self-hosted)", () => {
    // Mirrors the production split: current BYOC + hosted prices → "team",
    // the retired $199/$1,990/$200 prices → "team-legacy" (their
    // grandfathered limits).
    const map = buildPriceToPlan([
      ["price_team_149", "team"],
      ["price_team_149_yearly", "team"],
      ["price_team_hosted", "team"],
      ["price_team_hosted_yearly", "team"],
      ["price_team_199", "team-legacy"],
      ["price_team_199_yearly", "team-legacy"],
      ["price_team_legacy_200", "team-legacy"],
      ["price_scale", "scale"],
      ["price_scale_yearly", "scale"],
      ["price_scale_self_hosted", "scale"],
      ["price_scale_self_hosted_yearly", "scale"],
    ]);
    expect(map["price_team_legacy_200"]).toBe("team-legacy");
    expect(map["price_team_199"]).toBe("team-legacy");
    expect(map["price_team_149_yearly"]).toBe("team");
    expect(map["price_team_hosted"]).toBe("team");
    expect(
      Object.entries(map)
        .filter(([, plan]) => plan === "team")
        .map(([id]) => id),
    ).toHaveLength(4);
    expect(
      Object.entries(map)
        .filter(([, plan]) => plan === "team-legacy")
        .map(([id]) => id),
    ).toHaveLength(3);
    expect(
      Object.entries(map)
        .filter(([, plan]) => plan === "scale")
        .map(([id]) => id),
    ).toHaveLength(4);
  });
});
