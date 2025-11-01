const CARDS = Array.from({ length: 33 }, (_, idx) => idx + 3);
const HIDDEN_CARDS = 9;
const CHIPS_PER_PLAYER = 11;

function shuffle(list, rng = Math.random) {
  const array = [...list];
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function createDeck(rng = Math.random) {
  const deck = shuffle([...CARDS], rng);
  const removedCards = deck.splice(0, HIDDEN_CARDS);
  return {
    deck,
    removedCards,
    nextCard: () => {
      if (deck.length === 0) {
        return null;
      }
      return deck.shift();
    },
  };
}

function calculateScore(cards, chips) {
  if (!cards.length) {
    return -chips;
  }
  let total = 0;
  let previous = null;
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

function computeWinnerIds(players) {
  if (!players.length) {
    return [];
  }
  const lowest = Math.min(...players.map((player) => player.score));
  return players.filter((player) => player.score === lowest).map((player) => player.id);
}

module.exports = {
  CARDS,
  HIDDEN_CARDS,
  CHIPS_PER_PLAYER,
  createDeck,
  shuffle,
  calculateScore,
  computeWinnerIds,
};
