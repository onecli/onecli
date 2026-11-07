"use client";

import { useState } from "react";

/**
 * Keep a row where it was when the user clicked it. For lists that group or
 * sort by a state the user toggles in place (Active / Inactive, "on first"):
 * with instant switches, regrouping on the click would move the row out from
 * under the pointer mid-gesture, and a second click would land on another
 * row.
 *
 * `pin(id)` (call it from the row's click, before the write) freezes that
 * row's place as it is right now, for as long as the list stays mounted; the
 * next visit places it by its state again. Rows nobody clicked are always
 * placed by their current state, so changes made elsewhere (a connection
 * added and auto-granted, another tab, a refetch) still land where they
 * belong.
 */
export const usePinnedPlacement = <TPlace>(
  placeOf: (id: string) => TPlace,
): {
  placeOf: (id: string) => TPlace;
  pin: (id: string) => void;
} => {
  const [pinned, setPinned] = useState<ReadonlyMap<string, { place: TPlace }>>(
    () => new Map(),
  );
  return {
    placeOf: (id) => pinned.get(id)?.place ?? placeOf(id),
    // `placeOf` here is this render's, so it reads the state before the click.
    pin: (id) =>
      setPinned((current) =>
        current.has(id)
          ? current
          : new Map(current).set(id, { place: placeOf(id) }),
      ),
  };
};
