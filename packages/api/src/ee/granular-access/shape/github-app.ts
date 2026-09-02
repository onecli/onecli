import { ServiceError } from "../../../services/errors";

export const validateGitHubAppPolicy = async (
  metadata: Record<string, unknown> | null,
  policy: Record<string, unknown>,
): Promise<void> => {
  const repos = policy.repositories;
  if (!Array.isArray(repos) || repos.length === 0) return;

  const available = new Set((metadata?.repos as string[]) ?? []);
  const invalid = repos.filter((r: string) => !available.has(r));
  if (invalid.length > 0) {
    throw new ServiceError(
      "BAD_REQUEST",
      `Repositories not available on this installation: ${invalid.join(", ")}`,
    );
  }
};
