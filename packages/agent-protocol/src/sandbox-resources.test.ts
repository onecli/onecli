import { describe, expect, it } from "vitest";
import {
  sandboxResourceObservationSchema,
  sandboxResourceProfileId,
  sandboxResourceProfileSchema,
  sandboxResourceBoundsSchema,
  sandboxResourceProfileWithinBounds,
  sandboxStartResourcesSchema,
} from "./sandbox-resources";

const defaults = { cpuMillicores: 2000, memoryMiB: 4096, homeGiB: 40 };

describe("sandbox resource wire contract", () => {
  it("validates ordered backend bounds and accepts their inclusive edges", () => {
    const bounds = {
      min: { cpuMillicores: 250, memoryMiB: 128, homeGiB: 1 },
      max: defaults,
    };
    expect(sandboxResourceBoundsSchema.safeParse(bounds).success).toBe(true);
    expect(sandboxResourceProfileWithinBounds(bounds.min, bounds)).toBe(true);
    expect(sandboxResourceProfileWithinBounds(bounds.max, bounds)).toBe(true);
    for (const field of ["cpuMillicores", "memoryMiB", "homeGiB"] as const) {
      expect(
        sandboxResourceBoundsSchema.safeParse({
          ...bounds,
          min: { ...bounds.min, [field]: bounds.max[field] + 1 },
        }).success,
      ).toBe(false);
      expect(
        sandboxResourceProfileWithinBounds(
          { ...bounds.max, [field]: bounds.max[field] + 1 },
          bounds,
        ),
      ).toBe(false);
      expect(
        sandboxResourceProfileWithinBounds(
          { ...bounds.min, [field]: bounds.min[field] - 1 },
          bounds,
        ),
      ).toBe(false);
    }
  });

  it("rejects inconsistent axes without breaking legacy additive payloads", () => {
    const resources = {
      profile: defaults,
      profileId: "2000:4096:40",
      hasOverrides: true,
    };
    expect(sandboxStartResourcesSchema.safeParse(resources).success).toBe(true);
    expect(
      sandboxStartResourcesSchema.safeParse({ ...resources, overrideAxes: [] })
        .success,
    ).toBe(false);
    expect(
      sandboxStartResourcesSchema.safeParse({
        ...resources,
        overrideAxes: ["home"],
      }).success,
    ).toBe(true);
  });

  it("rejects fractional, unsafe and unbounded operator sizes", () => {
    for (const profile of [
      { ...defaults, cpuMillicores: 0 },
      { ...defaults, cpuMillicores: 100.5 },
      { ...defaults, memoryMiB: 262145 },
      { ...defaults, homeGiB: -1 },
      { ...defaults, homeGiB: Number.POSITIVE_INFINITY },
    ]) {
      expect(sandboxResourceProfileSchema.safeParse(profile).success).toBe(
        false,
      );
    }
  });

  it("checks deterministic identity before backend side effects", () => {
    const resources = {
      profile: defaults,
      profileId: sandboxResourceProfileId(defaults),
      hasOverrides: false,
    };
    expect(sandboxStartResourcesSchema.parse(resources)).toEqual(resources);
    expect(
      sandboxStartResourcesSchema.safeParse({
        ...resources,
        profileId: "old-profile",
      }).success,
    ).toBe(false);
  });

  it("allows measured old home geometry independently of desired disk", () => {
    const observation = {
      cpuMillicores: 2000,
      memoryMiB: 4096,
      profileId: "2000:4096:40",
      homeBytes: "21474836480",
    };
    expect(sandboxResourceObservationSchema.parse(observation)).toEqual(
      observation,
    );
    const unknownDisk = {
      cpuMillicores: observation.cpuMillicores,
      memoryMiB: observation.memoryMiB,
      profileId: observation.profileId,
    };
    expect(sandboxResourceObservationSchema.parse(unknownDisk)).toEqual(
      unknownDisk,
    );
  });

  it("rejects malformed and overflowing persisted byte observations", () => {
    const observation = {
      cpuMillicores: 2000,
      memoryMiB: 4096,
      profileId: "2000:4096:40",
    };
    for (const homeBytes of ["0", "-1", "1.5", "abc", "9223372036854775808"]) {
      expect(
        sandboxResourceObservationSchema.safeParse({
          ...observation,
          homeBytes,
        }).success,
      ).toBe(false);
    }
  });
});
