/** Where timeline cards render: grouped after the turn they follow, or at
 * the end of the thread. */
export interface SlottedCards<T> {
  afterTurn: Map<string, T[]>;
  atEnd: T[];
}

/**
 * Slot each card after the last turn that PRECEDES its creation, so it sits
 * where it fired and stays there as the conversation moves on. A card newer
 * than every turn, or newer than the final turn's start, lands at the end:
 * it never renders above the exchange that raised it. `turns` are in thread
 * order; `at` is the card's creation as ms epoch. `keepInRowId` names a
 * final turn whose newest cards stay in its row instead (a pinned send's
 * row, so they sit right under the reply rather than below its room).
 */
export const slotAfterTurns = <T extends { at: number }>(
  turns: readonly { id: string; createdAt: string }[],
  cards: readonly T[],
  keepInRowId?: string,
): SlottedCards<T> => {
  const lastId = turns[turns.length - 1]?.id;
  const afterTurn = new Map<string, T[]>();
  const atEnd: T[] = [];
  for (const card of cards) {
    let homeId: string | undefined;
    for (const turn of turns) {
      if (new Date(turn.createdAt).getTime() <= card.at) homeId = turn.id;
      else break;
    }
    if (homeId === undefined || (homeId === lastId && lastId !== keepInRowId)) {
      atEnd.push(card);
    } else {
      afterTurn.set(homeId, [...(afterTurn.get(homeId) ?? []), card]);
    }
  }
  return { afterTurn, atEnd };
};
