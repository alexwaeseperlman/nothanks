/* eslint-disable no-console */
const { io } = require("socket.io-client");

const SERVER_URL = process.env.BOT_SERVER_URL || "http://localhost:3000";
const BOT_COUNT = Number.parseInt(process.env.BOT_COUNT || "3", 10);
const BASE_NAME = process.env.BOT_NAME || "SampleBot";

const bots = [];

for (let i = 0; i < BOT_COUNT; i += 1) {
  const name = `${BASE_NAME}-${i + 1}-${Math.random().toString(36).slice(2, 5)}`;
  bots.push(spawnBot(name));
}

function spawnBot(name) {
  const socket = io(`${SERVER_URL}/bots`, {
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 4000,
  });

  const bot = {
    name,
    socket,
    matchId: null,
  };

  socket.on("connect", () => {
    console.log(`[${name}] connected, registering…`);
    socket.emit("registerBot", { name }, (ack) => {
      if (!ack?.ok) {
        console.error(`[${name}] registration failed: ${ack?.error || "unknown error"}`);
        return;
      }
      console.log(`[${name}] ready (rating ${ack.rating}).`);
      socket.emit("enqueue");
    });
  });

  socket.on("registered", (payload) => {
    if (payload?.stats) {
      console.log(`[${name}] stats`, payload.stats);
    }
  });

  socket.on("matchStarted", (state) => {
    bot.matchId = state?.matchId || null;
    console.log(`[${name}] match started against ${state.players.map((p) => p.name).join(", ")}`);
  });

  socket.on("turn", (state) => {
    if (!state) {
      return;
    }
    bot.matchId = state.matchId;
    const decision = chooseAction(state);
    console.log(
      `[${name}] chooses ${decision} (card ${state.currentCard}, pot ${state.pot}, chips ${state.you.chips}).`,
    );
    socket.emit("botAction", { matchId: state.matchId, action: decision });
  });

  socket.on("matchUpdate", (state) => {
    if (!state) {
      return;
    }
    bot.matchId = state.matchId;
  });

  socket.on("matchEnded", (summary) => {
    if (!summary) {
      return;
    }
    const placement = summary.standings.findIndex((entry) => entry.name === name) + 1;
    const score =
      summary.standings.find((entry) => entry.name === name)?.totalScore ?? "n/a";
    const win = summary.winners.includes(
      summary.standings.find((entry) => entry.name === name)?.botId,
    );
    console.log(
      `[${name}] match ended — place ${placement}/${summary.standings.length} (score ${score})${
        win ? " ✅" : ""
      }`,
    );
    bot.matchId = null;
  });

  socket.on("disconnect", (reason) => {
    console.log(`[${name}] disconnected: ${reason}`);
  });

  socket.on("error", (error) => {
    console.error(`[${name}] socket error:`, error);
  });

  return bot;
}

function chooseAction(state) {
  if (!state || state.currentCard == null) {
    return "take";
  }
  const { you, currentCard, pot } = state;

  if ((you?.chips ?? 0) <= 0) {
    return "take";
  }

  const minCard = Math.min(...(you.cards.length ? you.cards : [Infinity]));
  const potentialScore = currentCard - pot;
  if (potentialScore <= minCard) {
    return "take";
  }

  return Math.random() < 0.5 ? "pass" : "take";
}

process.on("SIGINT", () => {
  console.log("\nShutting down bots…");
  bots.forEach((bot) => {
    try {
      bot.socket.disconnect();
    } catch (error) {
      // ignore
    }
  });
  setTimeout(() => process.exit(0), 200);
});
