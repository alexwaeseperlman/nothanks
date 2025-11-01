const {
  CARDS,
  HIDDEN_CARDS,
  CHIPS_PER_PLAYER,
  shuffle,
  calculateScore,
} = require("./gameUtils");

const DEFAULT_RATING = 1200;
const MIN_RATING = 100;
const MATCH_SIZE = 3;
const TURN_TIMEOUT_MS = 5000;
const ELO_K = 32;

class BotArena {
  constructor(io, app) {
    this.namespace = io.of("/bots");
    this.app = app;

    this.names = new Map(); // lower-case name -> profile
    this.profilesById = new Map(); // id -> profile
    this.activeBots = new Map(); // botId -> bot connection info
    this.waitingQueue = [];
    this.matches = new Map(); // matchId -> BotMatch
    this.matchByBotId = new Map(); // botId -> matchId

    this.namespace.on("connection", this.handleConnection.bind(this));

    if (this.app) {
      this.app.get("/api/bots/ratings", (_req, res) => {
        res.json(this.getLeaderboard());
      });
    }
  }

  handleConnection(socket) {
    socket.once("registerBot", (payload = {}, ack) => {
      this.registerBot(socket, payload, ack);
    });
    socket.on("botAction", (payload = {}) => {
      this.handleBotAction(socket, payload);
    });
    socket.on("enqueue", () => {
      const bot = this.getBotBySocket(socket);
      if (bot) {
        this.enqueueBot(bot);
      }
    });
    socket.on("disconnect", () => {
      this.handleDisconnect(socket);
    });
  }

  registerBot(socket, payload, ack) {
    const name = typeof payload.name === "string" ? payload.name.trim() : "";
    if (!name) {
      this.sendAck(ack, { ok: false, error: "Bot name is required." });
      socket.disconnect(true);
      return;
    }
    if (name.length > 36) {
      this.sendAck(ack, { ok: false, error: "Bot name must be 36 characters or fewer." });
      socket.disconnect(true);
      return;
    }

    const key = name.toLowerCase();
    let profile = this.names.get(key);
    if (profile) {
      const existingBot = this.activeBots.get(profile.id);
      if (existingBot && existingBot.socket && existingBot.socket.id !== socket.id) {
        this.sendAck(ack, { ok: false, error: "Bot name already connected." });
        socket.disconnect(true);
        return;
      }
      profile.name = name;
    } else {
      const id = this.generateBotId(name);
      profile = {
        id,
        name,
        rating: DEFAULT_RATING,
        games: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        lastSeen: Date.now(),
      };
      this.names.set(key, profile);
      this.profilesById.set(id, profile);
    }

    const bot = {
      id: profile.id,
      name: profile.name,
      socket,
      connected: true,
      profile,
    };
    this.activeBots.set(bot.id, bot);
    socket.data.botId = bot.id;
    profile.lastSeen = Date.now();

    this.sendAck(ack, {
      ok: true,
      botId: bot.id,
      rating: Math.round(profile.rating),
      stats: this.buildStats(profile),
    });
    socket.emit("registered", {
      botId: bot.id,
      rating: Math.round(profile.rating),
      stats: this.buildStats(profile),
    });

    const matchId = this.matchByBotId.get(bot.id);
    if (matchId) {
      const match = this.matches.get(matchId);
      if (match) {
        match.reconnectBot(bot);
        return;
      }
      this.matchByBotId.delete(bot.id);
    }

    this.enqueueBot(bot);
  }

  handleBotAction(socket, payload) {
    const bot = this.getBotBySocket(socket);
    if (!bot) {
      return;
    }
    const { matchId, action } = payload;
    if (!matchId || typeof matchId !== "string") {
      return;
    }
    const match = this.matches.get(matchId);
    if (!match) {
      return;
    }
    match.receiveAction(bot.id, action);
  }

  handleDisconnect(socket) {
    const bot = this.getBotBySocket(socket);
    if (!bot) {
      return;
    }
    bot.connected = false;
    bot.socket = null;
    this.activeBots.delete(bot.id);

    this.removeFromQueue(bot.id);
    const matchId = this.matchByBotId.get(bot.id);
    if (matchId) {
      const match = this.matches.get(matchId);
      if (match) {
        match.botDisconnected(bot.id);
      }
    }
  }

  enqueueBot(bot) {
    if (this.matchByBotId.has(bot.id)) {
      return;
    }
    if (this.waitingQueue.includes(bot.id)) {
      return;
    }
    this.waitingQueue.push(bot.id);
    this.tryStartMatches();
  }

  removeFromQueue(botId) {
    const index = this.waitingQueue.indexOf(botId);
    if (index !== -1) {
      this.waitingQueue.splice(index, 1);
    }
  }

  tryStartMatches() {
    while (this.waitingQueue.length >= MATCH_SIZE) {
      const participants = [];
      for (let i = 0; i < MATCH_SIZE; i += 1) {
        const pickIndex = Math.floor(Math.random() * this.waitingQueue.length);
        const botId = this.waitingQueue.splice(pickIndex, 1)[0];
        const bot = this.activeBots.get(botId);
        if (bot && bot.connected) {
          participants.push(bot);
        }
      }
      if (participants.length === MATCH_SIZE) {
        this.startMatch(participants);
      } else {
        participants.forEach((bot) => {
          if (bot) {
            this.enqueueBot(bot);
          }
        });
        break;
      }
    }
  }

  startMatch(participants) {
    const match = new BotMatch(this, participants);
    this.matches.set(match.id, match);
    participants.forEach((bot) => {
      this.matchByBotId.set(bot.id, match.id);
    });
    match.start();
  }

  finishMatch(match) {
    this.matches.delete(match.id);
    match.participants.forEach((participant) => {
      this.matchByBotId.delete(participant.botId);
    });
  }

  updateStatsFromMatch(matchResult) {
    const standings = matchResult.standings;
    const winners = matchResult.winners;

    standings.forEach((entry) => {
      const profile = this.profilesById.get(entry.botId);
      if (!profile) {
        return;
      }
      profile.games += 1;
      profile.lastSeen = Date.now();
      if (winners.includes(entry.botId)) {
        if (winners.length > 1) {
          profile.draws += 1;
        } else {
          profile.wins += 1;
        }
      } else {
        profile.losses += 1;
      }
    });

    this.applyElo(standings);
  }

  applyElo(standings) {
    const deltas = new Map();
    for (let i = 0; i < standings.length; i += 1) {
      for (let j = i + 1; j < standings.length; j += 1) {
        const first = standings[i];
        const second = standings[j];
        const profileA = this.profilesById.get(first.botId);
        const profileB = this.profilesById.get(second.botId);
        if (!profileA || !profileB) {
          continue;
        }
        const ratingA = profileA.rating;
        const ratingB = profileB.rating;
        const expectedA = 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
        const expectedB = 1 - expectedA;

        let resultA = 0.5;
        if (first.totalScore < second.totalScore) {
          resultA = 1;
        } else if (first.totalScore > second.totalScore) {
          resultA = 0;
        }
        const resultB = 1 - resultA;

        const deltaA = ELO_K * (resultA - expectedA);
        const deltaB = ELO_K * (resultB - expectedB);

        deltas.set(first.botId, (deltas.get(first.botId) || 0) + deltaA);
        deltas.set(second.botId, (deltas.get(second.botId) || 0) + deltaB);
      }
    }

    deltas.forEach((delta, botId) => {
      const profile = this.profilesById.get(botId);
      if (!profile) {
        return;
      }
      profile.rating = Math.max(MIN_RATING, Math.round(profile.rating + delta));
    });
  }

  getLeaderboard() {
    const profiles = Array.from(this.profilesById.values());
    profiles.sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name));
    return profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      rating: Math.round(profile.rating),
      games: profile.games,
      wins: profile.wins,
      losses: profile.losses,
      draws: profile.draws,
      winRate: profile.games ? profile.wins / profile.games : 0,
      lastSeen: profile.lastSeen,
    }));
  }

  getBotBySocket(socket) {
    const botId = socket.data?.botId;
    if (!botId) {
      return null;
    }
    return this.activeBots.get(botId) || null;
  }

  sendAck(ack, payload) {
    if (typeof ack === "function") {
      ack(payload);
    }
  }

  buildStats(profile) {
    return {
      games: profile.games,
      wins: profile.wins,
      losses: profile.losses,
      draws: profile.draws,
      rating: Math.round(profile.rating),
      winRate: profile.games ? profile.wins / profile.games : 0,
    };
  }

  generateBotId(name) {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32) || "bot";
    let suffix = Math.random().toString(36).slice(2, 6);
    let candidate = `${slug}-${suffix}`;
    while (this.profilesById.has(candidate)) {
      suffix = Math.random().toString(36).slice(2, 6);
      candidate = `${slug}-${suffix}`;
    }
    return candidate;
  }
}

class BotMatch {
  constructor(arena, participants) {
    this.arena = arena;
    this.participants = participants.map((bot) => ({
      botId: bot.id,
      name: bot.name,
    }));
    this.id = `match-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.deck = [];
    this.removedCards = [];
    this.currentCard = null;
    this.pot = 0;
    this.turnIndex = 0;
    this.players = [];
    this.turnTimer = null;
    this.history = [];

    this.participants.forEach((participant) => {
      const bot = this.arena.activeBots.get(participant.botId);
      if (bot) {
        bot.currentMatchId = this.id;
      }
    });
  }

  start() {
    this.deck = shuffle([...CARDS]);
    this.removedCards = this.deck.splice(0, HIDDEN_CARDS);
    this.currentCard = this.deck.shift() ?? null;
    this.pot = 0;
    this.turnIndex = 0;
    this.players = this.participants.map((participant) => ({
      botId: participant.botId,
      name: participant.name,
      chips: CHIPS_PER_PLAYER,
      cards: [],
      connected: true,
    }));

    this.broadcast("matchStarted", this.buildPublicState());
    if (this.currentCard !== null) {
      this.promptPlayer();
    } else {
      this.finish();
    }
  }

  reconnectBot(bot) {
    const participant = this.participants.find((entry) => entry.botId === bot.id);
    if (!participant) {
      return;
    }
    this.sendToBot(bot.id, "matchResumed", {
      matchId: this.id,
      state: this.buildBotView(bot.id),
    });
    if (this.players[this.turnIndex]?.botId === bot.id) {
      this.promptPlayer(); // ensure they get latest timer
    }
  }

  receiveAction(botId, action) {
    const current = this.players[this.turnIndex];
    if (!current || current.botId !== botId) {
      return;
    }
    const normalized = action === "pass" ? "pass" : "take";
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    if (normalized === "pass" && current.chips <= 0) {
      this.applyTake(current);
      this.advanceAfterTake(current);
      return;
    }
    if (normalized === "pass") {
      this.applyPass(current);
      this.advanceTurn();
    } else {
      this.applyTake(current);
      this.advanceAfterTake(current);
    }
  }

  botDisconnected(botId) {
    const player = this.players.find((entry) => entry.botId === botId);
    if (player) {
      player.connected = false;
    }
    if (this.players[this.turnIndex]?.botId === botId) {
      this.receiveAction(botId, "take");
    }
  }

  applyPass(player) {
    if (player.chips > 0) {
      player.chips -= 1;
      this.pot += 1;
      this.log(`${player.name} passed.`);
    } else {
      this.log(`${player.name} tried to pass with no chips.`);
    }
  }

  applyTake(player) {
    if (this.currentCard === null) {
      return;
    }
    player.cards.push(this.currentCard);
    if (this.pot > 0) {
      player.chips += this.pot;
    }
    this.log(`${player.name} took ${this.currentCard}${this.pot ? ` and ${this.pot} chips` : ""}.`);
    this.pot = 0;
    this.currentCard = this.deck.shift() ?? null;
  }

  advanceTurn() {
    if (this.players.length === 0) {
      return;
    }
    for (let i = 0; i < this.players.length; i += 1) {
      this.turnIndex = (this.turnIndex + 1) % this.players.length;
      if (this.players[this.turnIndex].connected) {
        break;
      }
    }
    this.broadcast("matchUpdate", this.buildPublicState());
    if (this.currentCard === null) {
      this.finish();
      return;
    }
    this.promptPlayer();
  }

  advanceAfterTake(player) {
    this.broadcast("matchUpdate", this.buildPublicState());
    if (this.currentCard === null) {
      this.finish();
      return;
    }
    const current = this.players[this.turnIndex];
    if (current && current.connected && current.botId === player.botId) {
      this.promptPlayer();
    } else {
      this.advanceTurn();
    }
  }

  promptPlayer() {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
    }
    const current = this.players[this.turnIndex];
    if (!current) {
      return;
    }
    if (!current.connected) {
      this.advanceTurn();
      return;
    }
    this.sendToBot(current.botId, "turn", this.buildBotView(current.botId));
    this.turnTimer = setTimeout(() => {
      this.turnTimer = null;
      const action = this.pickFallbackAction(current);
      this.receiveAction(current.botId, action);
    }, TURN_TIMEOUT_MS);
  }

  pickFallbackAction(player) {
    if (player.chips <= 0) {
      return "take";
    }
    return Math.random() < 0.5 ? "pass" : "take";
  }

  buildBotView(botId) {
    const player = this.players.find((entry) => entry.botId === botId);
    return {
      matchId: this.id,
      you: {
        name: player?.name || "",
        chips: player?.chips ?? 0,
        cards: (player?.cards || []).slice().sort((a, b) => a - b),
      },
      currentCard: this.currentCard,
      pot: this.pot,
      deckCount: this.deck.length,
      removedCount: this.removedCards.length,
      players: this.players.map((entry, index) => ({
        botId: entry.botId,
        name: entry.name,
        chips: entry.chips,
        cards: entry.cards.slice().sort((a, b) => a - b),
        isTurn: index === this.turnIndex,
        connected: entry.connected,
      })),
      history: this.history.slice(-5),
    };
  }

  buildPublicState() {
    return {
      matchId: this.id,
      currentCard: this.currentCard,
      pot: this.pot,
      deckCount: this.deck.length,
      removedCount: this.removedCards.length,
      players: this.players.map((entry, index) => ({
        botId: entry.botId,
        name: entry.name,
        chips: entry.chips,
        cards: entry.cards.slice().sort((a, b) => a - b),
        isTurn: index === this.turnIndex,
        connected: entry.connected,
      })),
      history: this.history.slice(-10),
    };
  }

  finish() {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    const standings = this.players.map((entry) => ({
      botId: entry.botId,
      name: entry.name,
      totalScore: calculateScore(entry.cards, entry.chips),
      cards: entry.cards.slice().sort((a, b) => a - b),
      chips: entry.chips,
    }));
    standings.sort((a, b) => a.totalScore - b.totalScore);
    const bestScore = standings[0]?.totalScore ?? 0;
    const winners = standings.filter((entry) => entry.totalScore === bestScore).map((entry) => entry.botId);

    this.broadcast("matchEnded", {
      matchId: this.id,
      standings,
      winners,
    });

    standings.forEach((entry) => {
      const bot = this.arena.activeBots.get(entry.botId);
      if (bot) {
        bot.currentMatchId = null;
      }
    });

    this.arena.updateStatsFromMatch({ standings, winners });
    this.arena.finishMatch(this);

    standings.forEach((entry) => {
      const bot = this.arena.activeBots.get(entry.botId);
      if (bot && bot.connected) {
        this.arena.enqueueBot(bot);
      }
    });
  }

  broadcast(event, payload) {
    this.participants.forEach((participant) => {
      this.sendToBot(participant.botId, event, payload);
    });
  }

  sendToBot(botId, event, payload) {
    const bot = this.arena.activeBots.get(botId);
    if (!bot || !bot.connected || !bot.socket) {
      return;
    }
    bot.socket.emit(event, payload);
  }

  log(message) {
    this.history.push({
      timestamp: Date.now(),
      message,
    });
    if (this.history.length > 50) {
      this.history.splice(0, this.history.length - 50);
    }
  }
}

module.exports = BotArena;
