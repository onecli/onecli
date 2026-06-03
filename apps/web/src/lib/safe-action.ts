import { unstable_rethrow } from "next/navigation";

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export async function safeAction<T>(
  fn: () => Promise<T>,
): Promise<ActionResult<T>> {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (err) {
    unstable_rethrow(err);
    const message =
      err instanceof Error
        ? err.message
        : "Something went wrong. Please try again.";
    return { ok: false, error: message };
  }
}
