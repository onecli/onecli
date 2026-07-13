import type { DirectoryPage } from "./types";

/**
 * Drains a cursor-paginated directory list (the §3.5 envelope) into one
 * array — for pickers and replace-set dialogs, where operating on a
 * truncated page would silently drop the unseen rows on save. Bounded so a
 * runaway directory can't hang the UI.
 */
export const fetchAllPages = async <T>(
  fetchPage: (cursor?: string) => Promise<DirectoryPage<T>>,
  maxItems = 5000,
): Promise<T[]> => {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetchPage(cursor);
    items.push(...page.data);
    cursor = page.nextCursor ?? undefined;
  } while (cursor && items.length < maxItems);
  return items;
};
