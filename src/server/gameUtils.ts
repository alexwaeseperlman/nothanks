export const CARDS = Array.from({ length: 33 }, (_, idx) => idx + 3);
export const HIDDEN_CARDS = 9;
export const CHIPS_PER_PLAYER = 11;

export function shuffle<T>(list: T[], rng: () => number = Math.random): T[] {
  const array = [...list];
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

export function calculateScore(cards: number[], chips: number): number {
  if (!cards.length) {
    return -chips;
  }
  let total = 0;
  let previous: number | null = null;
  cards
    .slice()
    .sort((a, b) => a - b)
    .forEach((card) => {
      if (previous === null || card !== previous + 1) {
        total += card;
      }
      previous = card;
    });
  return total - chips;
}

export function computeWinnerIds<T extends { id: string; score: number }>(
  players: T[],
): string[] {
  if (!players.length) {
    return [];
  }
  const lowest = Math.min(...players.map((player) => player.score));
  return players
    .filter((player) => player.score === lowest)
    .map((player) => player.id);
}
