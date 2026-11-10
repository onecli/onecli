"use client";

import { useState } from "react";

/**
 * Whether `live` has been true at any point while this component was on
 * screen: the reader WATCHED the thing run. Settled history (a page load, a
 * thread opened after the fact) never was; a turn the reader saw working
 * always was, even after it settles.
 *
 * This is what decides whether an answer that lands whole flows in or is
 * simply there: an answer arriving in front of the reader should read as
 * arriving, one loaded from history should not replay.
 */
export const useWasLive = (live: boolean): boolean => {
  const [was, setWas] = useState(live);
  // Recorded during render (React's "store information from previous
  // renders" pattern): the flag is right on the very render the turn
  // settles, with no effect and no extra frame.
  if (live && !was) setWas(true);
  return was || live;
};
