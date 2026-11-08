import { z } from "zod";

/** Backend-neutral sizing units. Limits bound operator-authored database values too. */
export const sandboxResourceProfileSchema = z.object({
  cpuMillicores: z.number().int().min(100).max(64_000),
  memoryMiB: z.number().int().min(128).max(262_144),
  homeGiB: z.number().int().min(1).max(4096),
});
export type SandboxResourceProfile = z.infer<
  typeof sandboxResourceProfileSchema
>;

export const sandboxResourceSupportSchema = z.object({
  cpu: z.boolean(),
  memory: z.boolean(),
  homeProvision: z.boolean(),
});
export type SandboxResourceSupport = z.infer<
  typeof sandboxResourceSupportSchema
>;

export const sandboxResourceBoundsSchema = z
  .object({
    min: sandboxResourceProfileSchema,
    max: sandboxResourceProfileSchema,
  })
  .refine(
    ({ min, max }) =>
      min.cpuMillicores <= max.cpuMillicores &&
      min.memoryMiB <= max.memoryMiB &&
      min.homeGiB <= max.homeGiB,
    { message: "Resource minimums must not exceed maximums" },
  );
export type SandboxResourceBounds = z.infer<typeof sandboxResourceBoundsSchema>;

/** Deployment bounds can be narrower than the backend-neutral wire envelope. */
export const sandboxResourceProfileWithinBounds = (
  profile: SandboxResourceProfile,
  bounds: SandboxResourceBounds,
): boolean =>
  profile.cpuMillicores >= bounds.min.cpuMillicores &&
  profile.cpuMillicores <= bounds.max.cpuMillicores &&
  profile.memoryMiB >= bounds.min.memoryMiB &&
  profile.memoryMiB <= bounds.max.memoryMiB &&
  profile.homeGiB >= bounds.min.homeGiB &&
  profile.homeGiB <= bounds.max.homeGiB;

/** Stable identity, deliberately pure so browser-reachable code needs no crypto. */
export const sandboxResourceProfileId = (
  profile: SandboxResourceProfile,
): string => `${profile.cpuMillicores}:${profile.memoryMiB}:${profile.homeGiB}`;

export const sandboxStartResourcesSchema = z
  .object({
    profile: sandboxResourceProfileSchema,
    profileId: z.string().min(1).max(100),
    hasOverrides: z.boolean(),
    /** Effective explicit axes, including overrides equal to a default value. */
    overrideAxes: z.array(z.enum(["cpu", "memory", "home"])).optional(),
    /**
     * The home's own disk baseline, when the profile was resolved for a
     * managed home (frozen at birth or verified at adoption). A profile
     * whose `homeGiB` equals it describes the size the home already HAS,
     * not a quota the backend must enforce: a backend that cannot
     * provision homes still runs such a home at its own size. Absent for a
     * blank sandbox (older control planes never send it).
     */
    baselineHomeGiB: sandboxResourceProfileSchema.shape.homeGiB.optional(),
  })
  .refine(
    (value) => value.profileId === sandboxResourceProfileId(value.profile),
    {
      message: "Resource profile identity does not match its values",
    },
  )
  .refine(
    (value) =>
      value.overrideAxes === undefined ||
      value.hasOverrides === value.overrideAxes.length > 0,
    { message: "Resource override axes do not match override presence" },
  );
export type SandboxStartResources = z.infer<typeof sandboxStartResourcesSchema>;
export type SandboxResources = SandboxStartResources;

/** Actual observations only. An absent disk size means the backend cannot prove it. */
export const sandboxResourceObservationSchema = z.object({
  cpuMillicores: sandboxResourceProfileSchema.shape.cpuMillicores,
  memoryMiB: sandboxResourceProfileSchema.shape.memoryMiB,
  homeBytes: z
    .string()
    .regex(/^[1-9][0-9]{0,18}$/)
    .refine(
      (value) =>
        /^[1-9][0-9]{0,18}$/.test(value) &&
        BigInt(value) <= 9_223_372_036_854_775_807n,
      "Observed home size exceeds database capacity",
    )
    .optional(),
  profileId: z.string().min(1).max(100),
});
export type SandboxResourceObservation = z.infer<
  typeof sandboxResourceObservationSchema
>;
