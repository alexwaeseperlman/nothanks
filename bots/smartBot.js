/* eslint-disable no-console */
const { io } = require("socket.io-client");
const { calculateScore } = require("../server/gameUtils");

const SERVER_URL = process.env.BOT_SERVER_URL || "http://localhost:3000";
const BOT_NAME = process.env.BOT_NAME || "SmartBot";

class SmartBot {
  constructor(name) {
    this.name = name;
    this.socket = null;
    this.currentMatchId = null;
    this.seenCards = new Set();
    this.playerSnapshot = new Map();
  }

  connect() {
    this.socket = io(`${SERVER_URL}/bots`, {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 4000,
    });

    this.socket.on("connect", () => {
      console.log(`[${this.name}] Connected. Registering…`);
      this.socket.emit("registerBot", { name: this.name }, (ack) => {
        if (!ack?.ok) {
          console.error(`[${this.name}] Registration failed: ${ack?.error || "unknown"}`);
          return;
        }
        console.log(
          `[${this.name}] Registered with rating ${ack.rating}. Ready to queue.`,
        );
        this.socket.emit("enqueue");
      });
    });

    this.socket.on("registered", (payload) => {
      if (payload?.stats) {
        console.log(`[${this.name}] Current stats ->`, payload.stats);
      }
    });

    this.socket.on("matchStarted", (state) => {
      this.handleMatchStarted(state);
    });

    this.socket.on("matchUpdate", (state) => {
      this.handleMatchUpdate(state);
    });

    this.socket.on("turn", (state) => {
      this.handleTurn(state);
    });

    this.socket.on("matchEnded", (summary) => {
      this.handleMatchEnded(summary);
    });

    this.socket.on("disconnect", (reason) => {
      console.log(`[${this.name}] Disconnected: ${reason}`);
    });

    this.socket.on("error", (error) => {
      console.error(`[${this.name}] Socket error:`, error);
    });
  }

  handleMatchStarted(state) {
    this.currentMatchId = state?.matchId || null;
    this.resetMatchMemory();
    this.ingestPlayers(state?.players || []);
    console.log(
      `[${this.name}] Match started vs ${state.players
        .map((player) => player.name)
        .join(", ")}`,
    );
  }

  handleMatchUpdate(state) {
    if (!state) {
      return;
    }
    this.currentMatchId = state.matchId;
    this.ingestPlayers(state.players || []);
  }

  handleTurn(state) {
    if (!state || state.matchId !== this.currentMatchId) {
      return;
    }
    this.ingestPlayers(state.players || []);

    const action = this.chooseAction(state);
    this.socket.emit("botAction", { matchId: state.matchId, action });
  }

  handleMatchEnded(summary) {
    if (!summary) {
      return;
    }
    const me = summary.standings.find((entry) => entry.name === this.name);
    const place =
      summary.standings.findIndex((entry) => entry.name === this.name) + 1;
    const info =
      me && typeof me.totalScore === "number"
        ? `score ${me.totalScore}`
        : "score n/a";
    console.log(
      `[${this.name}] Match ended — place ${place}/${summary.standings.length} (${info})${
        summary.winners.includes(me?.botId) ? " ✅" : ""
      }`,
    );
    this.currentMatchId = null;
    // Requeue for the next match after a short break.
    setTimeout(() => {
      this.socket?.emit("enqueue");
    }, 500);
  }

  resetMatchMemory() {
    this.seenCards.clear();
    this.playerSnapshot.clear();
  }

  ingestPlayers(players) {
    players.forEach((player) => {
      this.playerSnapshot.set(player.botId, {
        name: player.name,
        cards: [...(player.cards || [])],
        chips: player.chips ?? 0,
        connected: player.connected !== false,
        isTurn: Boolean(player.isTurn),
      });
      (player.cards || []).forEach((card) => this.seenCards.add(card));
    });
  }

  chooseAction(state) {
    const you = (state.players || []).find((player) => player.name === this.name);
    if (!you) {
      return "take";
    }
    const currentCard = state.currentCard;
    if (currentCard == null) {
      return "take";
    }
    const pot = state.pot ?? 0;
    const chips = you.chips ?? 0;
    const cards = [...(you.cards || [])].sort((a, b) => a - b);

    if (chips <= 0) {
      return "take";
    }

    const currentScore = calculateScore(cards, chips);
    const scoreIfTakeNow = calculateScore([...cards, currentCard], chips + pot);
    const deltaTake = scoreIfTakeNow - currentScore;

    const scoreIfPassImmediate = calculateScore(cards, chips - 1);
    const deltaPassImmediate = scoreIfPassImmediate - currentScore;

    const passOutcome = this.simulatePass(state, you, currentCard);
    let deltaPass;
    if (passOutcome.takenByOther) {
      deltaPass = deltaPassImmediate;
    } else {
      const futureChips = chips - 1;
      const futurePot = pot + passOutcome.passes;
      const futureScore = calculateScore([...cards, currentCard], futureChips + futurePot);
      deltaPass = futureScore - currentScore;
      // Penalize long loops where we keep feeding chips.
      deltaPass += passOutcome.passes * 0.2;
    }

    // Core decision
    if (deltaTake <= deltaPass - 0.5) {
      return "take";
    }
    if (deltaPass <= deltaTake - 0.5) {
      return "pass";
    }

    // Situational adjustments
    const runPotential = this.countRunNeighbors(cards, currentCard);
    if (runPotential >= 2 && deltaTake <= deltaPass + 1) {
      return "take";
    }

    if (pot >= 3 && deltaTake <= deltaPass + 2) {
      return "take";
    }

    if (chips <= 2 && deltaTake <= deltaPass + 1.5) {
      return "take";
    }

    if (cards.length === 0 && currentCard <= 16 && pot >= 1) {
      return "take";
    }

    if (passOutcome.forcedSelf && pot < 3 && deltaPass < deltaTake + 0.5) {
      return "pass";
    }

    if (deltaPass <= deltaTake) {
      return "pass";
    }
    return "take";
  }

  simulatePass(state, you, card) {
    const players = state.players || [];
    const pot = state.pot ?? 0;
    const yourIndex = players.findIndex((player) => player.name === this.name);
    if (yourIndex === -1) {
      return { takenByOther: false, passes: 1, forcedSelf: true };
    }
    let passingPot = pot + 1;
    let passes = 1; // Our own pass contributes to the pot.

    for (let offset = 1; offset < players.length; offset += 1) {
      const idx = (yourIndex + offset) % players.length;
      const player = players[idx];
      if (!player) {
        continue;
      }
      const snapshot = this.playerSnapshot.get(player.botId);
      const chips = snapshot?.chips ?? player.chips ?? 0;
      const otherCards = [...(snapshot?.cards || player.cards || [])];

      if (chips <= 0) {
        return { takenByOther: true, passes, taker: player };
      }

      const currentScore = calculateScore(otherCards, chips);
      const scoreIfTake = calculateScore([...otherCards, card], chips + passingPot);
      const scoreIfPass = calculateScore(otherCards, chips - 1);
      const deltaTake = scoreIfTake - currentScore;
      const deltaPass = scoreIfPass - currentScore;

      if (deltaTake <= deltaPass - 0.25 || deltaTake <= 0) {
        return { takenByOther: true, passes, taker: player };
      }

      passingPot += 1;
      passes += 1;
    }

    return { takenByOther: false, passes, forcedSelf: true };
  }

  countRunNeighbors(cards, card) {
    let count = 0;
    if (cards.includes(card - 1)) {
      count += 1;
    }
    if (cards.includes(card + 1)) {
      count += 1;
    }
    return count;
  }
}

const botCount = Number.parseInt(process.env.BOT_COUNT || "1", 10);
const bots = [];

for (let index = 0; index < botCount; index += 1) {
  const suffix = botCount > 1 ? `-${index + 1}` : "";
  const bot = new SmartBot(`${BOT_NAME}${suffix}`);
  bot.connect();
  bots.push(bot);
}

process.on("SIGINT", () => {
  console.log("\nStopping smart bots…");
  bots.forEach((bot) => {
    try {
      bot.socket?.disconnect();
    } catch (error) {
      // ignore cleanup errors
    }
  });
  setTimeout(() => process.exit(0), 200);
});
