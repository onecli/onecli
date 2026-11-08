import { ServiceError } from "../services/errors";

/**
 * Request-body helpers shared by the route files.
 *
 * `parseBody` reads a clone so the original body stays readable, and turns a
 * missing or malformed JSON body into `null` for the route's schema to judge.
 */
export const parseBody = async (raw: Request) =>
  await raw
    .clone()
    .json()
    .catch(() => null);

/** Validation failures throw so they render as the standard error envelope. */
export const parsed = <T>(
  result: {
    success: boolean;
    data?: T;
    error?: { issues: { message?: string }[] };
  },
  fallback: string,
): T => {
  if (!result.success || result.data === undefined) {
    throw new ServiceError(
      "UNPROCESSABLE",
      result.error?.issues[0]?.message ?? fallback,
    );
  }
  return result.data;
};
