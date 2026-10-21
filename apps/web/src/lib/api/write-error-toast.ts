import { toast } from "sonner";
import { ApiError } from "@/lib/api/client";

/** How long a failed-write toast stays: long enough to read the reason and
 * reach Retry, which a 4s success-length toast is not. */
const ERROR_DURATION_MS = 8000;

/**
 * Whether trying the same write again could succeed: the network dropped
 * (fetch rejected outright, no ApiError), the server failed (5xx), or it
 * timed out / rate limited (408/429). A 4xx refusal (forbidden, invalid, a
 * plan limit) answers the same way every time, so no Retry is offered for it.
 */
export const isRetryable = (error: unknown): boolean =>
  !(error instanceof ApiError) ||
  error.status >= 500 ||
  error.status === 408 ||
  error.status === 429;

export interface WriteErrorToastOptions {
  /** Re-run the failed write. Offered only when the failure was transient. */
  retry?: () => void;
  /** A stable id, so a burst of failures on one control shows one toast. */
  id?: string;
}

/**
 * The one failure notice for an optimistic write. The control has already
 * moved back by the time this shows, so the title says what did not happen
 * ("Couldn't turn on GitHub for Donna") and the description carries the
 * server's own reason when it gave one. A transient failure gets Retry.
 *
 * Sonner renders into an `aria-live="polite"` region and never takes focus,
 * so the person keeps their place.
 */
export const writeErrorToast = (
  title: string,
  error: unknown,
  { retry, id }: WriteErrorToastOptions = {},
): void => {
  const reason =
    error instanceof ApiError
      ? error.message
      : "Check your connection and try again.";
  toast.error(title, {
    ...(id !== undefined && { id }),
    description: reason,
    duration: ERROR_DURATION_MS,
    ...(retry &&
      isRetryable(error) && {
        action: { label: "Retry", onClick: retry },
      }),
  });
};
