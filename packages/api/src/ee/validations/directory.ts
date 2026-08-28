import { z } from "zod";
import { DIRECTORY_PAGE_MAX } from "../services/directory-pagination";

/**
 * Common query params for directory-scale lists (§3.5 envelope): cursor
 * pagination + free-text search. Query params arrive as strings, so `limit`
 * is coerced.
 */
export const directoryListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(DIRECTORY_PAGE_MAX).optional(),
  cursor: z.string().min(1).optional(),
  q: z.string().trim().min(1).max(200).optional(),
});
