import path from "path";
import express, { Request, Response } from "express";
import http from "http";
import { Server, Socket } from "socket.io";
import BotArena from "./botArena";
import {
  CARDS,
  HIDDEN_CARDS,
  CHIPS_PER_PLAYER,
  calculateScore,
  computeWinnerIds,
  shuffle,
} from "./gameUtils";

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const MAX_NAME_LENGTH = 24;
const MAX_EVENTS = 50;

type Player = {
  id: string;
  name: string;
  chips: number;
  cards: number[];
  connected: boolean;
  socketId: string | null;
};

type RoomState = "lobby" | "inProgress" | "finished";

type RoomEvent = {
  timestamp: number;
  message: string;
};

type Room = {
  id: string;
  state: RoomState;
  players: Player[];
  hostId: string | null;
  deck: number[];
  removedCards: number[];
  currentCard: number | null;
  pot: number;
  turnIndex: number;
  events: RoomEvent[];
};

type SanitizedPlayer = {
  id: string;
  name: string;
  chips: number;
  cards: number[];
  score: number;
  connected: boolean;
  isHost: boolean;
  isTurn: boolean;
};

type SanitizedRoom = {
  roomId: string;
  state: RoomState;
  players: SanitizedPlayer[];
  pot: number;
  currentCard: number | null;
  deckCount: number;
  removedCount: number;
  hostId: string | null;
  winnerIds: string[];
  events: RoomEvent[];
};

const app = express();
const server = http.createServer(app);
const io = new Server(server);
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const botArena = new BotArena(io, app);

const rooms = new Map<string, Room>();

const ROOT_DIR = path.resolve(__dirname, "..", "..");

app.use(express.static(path.join(ROOT_DIR, "public")));

app.get("/room/:roomId", (_req: Request, res: Response) => {
  res.sendFile(path.join(ROOT_DIR, "public", "index.html"));
});

app.get("/bots", (_req: Request, res: Response) => {
  res.sendFile(path.join(ROOT_DIR, "public", "bots.html"));
});

io.on("connection", (socket: Socket) => {
  socket.on(
    "joinRoom",
    (payload: { roomId?: string; name?: string; playerId?: string } = {}, ack?: (response: unknown) => void) => {
      const { roomId, name } = payload;
      if (!roomId || typeof roomId !== "string") {
        emitError(socket, "Room id required.");
        return;
      }
      const trimmedName =
        `${name || ""}`.trim().slice(0, MAX_NAME_LENGTH) || "Player";

      const room = getOrCreateRoom(roomId);

      const existingByName = room.players.find((p) =>
        equalsIgnoreCase(p.name, trimmedName),
      );
      if (
        existingByName &&
        existingByName.connected &&
        existingByName.socketId !== socket.id
      ) {
        emitError(socket, "That name is already seated. Try a different one.");
        return;
      }

      let player: Player;
      if (existingByName) {
        player = existingByName;
        player.name = trimmedName;
        player.connected = true;
        player.socketId = socket.id;
        addEvent(room, `${player.name} rejoined.`);
      } else {
        const id = generatePlayerId(room, trimmedName);
        player = {
          id,
          name: trimmedName,
          chips: 0,
          cards: [],
          connected: true,
          socketId: socket.id,
        };
        room.players.push(player);
        addEvent(room, `${player.name} joined the lobby.`);
      }

      if (!room.hostId || !room.players.some((p) => p.id === room.hostId)) {
        room.hostId = room.players[0]?.id ?? null;
      }

      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.playerId = player.id;

      if (room.state !== "inProgress") {
        player.chips = CHIPS_PER_PLAYER;
        player.cards = [];
      } else if (room.turnIndex === -1) {
        const nextIndex = room.players.findIndex((entry) => entry.connected);
        if (nextIndex !== -1) {
          room.turnIndex = nextIndex;
        }
      }

      const state = sanitizeRoom(room);
      ack?.({ ok: true, playerId: player.id, roomId, state });
      broadcastState(roomId);
    },
  );

  socket.on("startGame", () => {
    const room = getRoomForSocket(socket);
    if (!room) {
      emitError(socket, "Join a room before starting a game.");
      return;
    }

    if (room.state === "inProgress") {
      emitError(socket, "Game already in progress.");
      return;
    }

    if (room.players.length < 2) {
      emitError(socket, "Need at least two players to start.");
      return;
    }

    const playerId = socket.data.playerId as string | undefined;
    const player = playerId ? findPlayer(room, playerId) : null;
    if (!player || room.hostId !== player.id) {
      emitError(socket, "Only the host can start the game.");
      return;
    }

    startGame(room, player.id);
    broadcastState(room.id);
  });

  socket.on("playerAction", (payload: { action?: string } = {}) => {
    const { action } = payload;
    const room = getRoomForSocket(socket);
    if (!room) {
      emitError(socket, "Join a room first.");
      return;
    }

    if (room.state !== "inProgress") {
      emitError(socket, "No active game.");
      return;
    }

    const playerId = socket.data.playerId as string | undefined;
    const playerIndex = room.players.findIndex((p) => p.id === playerId);
    if (playerIndex === -1) {
      emitError(socket, "Player not found in this room.");
      return;
    }

    const player = room.players[playerIndex];
    if (player.socketId !== socket.id) {
      emitError(socket, "You are not the active connection for this player.");
      return;
    }

    if (playerIndex !== room.turnIndex) {
      emitError(socket, "It is not your turn.");
      return;
    }

    if (action === "pass") {
      const error = handlePass(room, player);
      if (error) {
        emitError(socket, error);
        return;
      }
    } else if (action === "take") {
      const error = handleTake(room, player);
      if (error) {
        emitError(socket, error);
        return;
      }
    } else {
      emitError(socket, "Unknown action.");
      return;
    }

    broadcastState(room.id);
  });

  socket.on("disconnect", () => {
    const room = getRoomForSocket(socket);
    if (!room) {
      return;
    }
    const playerId = socket.data.playerId as string | undefined;
    const playerIndex = room.players.findIndex((p) => p.id === playerId);
    if (playerIndex === -1) {
      cleanupRoomIfEmpty(room.id);
      return;
    }

    const player = room.players[playerIndex];
    player.connected = false;
    player.socketId = null;

    if (room.state === "lobby") {
      room.players.splice(playerIndex, 1);
      addEvent(room, `${player.name} left the lobby.`);
      if (room.hostId === player.id) {
        room.hostId = room.players[0]?.id ?? null;
      }
    } else {
      addEvent(room, `${player.name} disconnected.`);
      if (room.turnIndex === playerIndex) {
        advanceTurn(room);
      }
    }

    cleanupRoomIfEmpty(room.id);
    broadcastState(room.id);
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on http://localhost:${PORT}`);
});

function emitError(socket: Socket, message: string): void {
  socket.emit("errorMessage", message);
}

function getOrCreateRoom(roomId: string): Room {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      state: "lobby",
      players: [],
      hostId: null,
      deck: [],
      removedCards: [],
      currentCard: null,
      pot: 0,
      turnIndex: -1,
      events: [],
    });
  }
  return rooms.get(roomId) as Room;
}

function getRoomForSocket(socket: Socket): Room | null {
  const roomId = socket.data.roomId as string | undefined;
  if (!roomId) {
    return null;
  }
  return rooms.get(roomId) ?? null;
}

function findPlayer(room: Room, playerId: string): Player | null {
  return room.players.find((p) => p.id === playerId) ?? null;
}

function startGame(room: Room, initiatorId: string): void {
  room.deck = shuffle([...CARDS]);
  room.removedCards = room.deck.splice(0, HIDDEN_CARDS);
  room.currentCard = null;
  room.pot = 0;
  room.state = "inProgress";
  room.events = [];

  room.players.forEach((player) => {
    player.cards = [];
    player.chips = CHIPS_PER_PLAYER;
  });

  const firstIndex = Math.max(
    0,
    room.players.findIndex((p) => p.id === initiatorId),
  );
  room.turnIndex = firstIndex;

  drawNextCard(room);
  addEvent(room, "Game started.");
}

function handlePass(room: Room, player: Player): string | null {
  if (room.currentCard == null) {
    return "No card to pass on.";
  }
  if (player.chips <= 0) {
    return "You have no chips left. You must take the card.";
  }

  player.chips -= 1;
  room.pot += 1;
  addEvent(room, `${player.name} said no thanks.`);
  advanceTurn(room);
  return null;
}

function handleTake(room: Room, player: Player): string | null {
  if (room.currentCard == null) {
    return "No card to take.";
  }

  const playerIndex = room.players.findIndex((entry) => entry.id === player.id);
  player.cards.push(room.currentCard);
  if (room.pot > 0) {
    player.chips += room.pot;
  }
  addEvent(room, `${player.name} took card ${room.currentCard}.`);
  room.pot = 0;

  drawNextCard(room);
  if (room.state === "inProgress") {
    if (playerIndex !== -1 && room.players[playerIndex]?.connected) {
      room.turnIndex = playerIndex;
    } else {
      advanceTurn(room);
    }
  }
  return null;
}

function drawNextCard(room: Room): void {
  if (room.deck.length === 0) {
    finishGame(room);
    return;
  }
  room.currentCard = room.deck.shift() ?? null;
}

function advanceTurn(room: Room): void {
  if (room.players.length === 0) {
    room.turnIndex = -1;
    return;
  }
  let nextIndex = room.turnIndex;
  for (let i = 0; i < room.players.length; i += 1) {
    nextIndex = (nextIndex + 1) % room.players.length;
    const candidate = room.players[nextIndex];
    if (candidate.connected) {
      room.turnIndex = nextIndex;
      return;
    }
  }
  room.turnIndex = -1;
}

function finishGame(room: Room): void {
  if (room.state === "finished") {
    return;
  }
  room.state = "finished";
  room.currentCard = null;
  room.turnIndex = -1;

  const scores = room.players.map((p) => ({
    id: p.id,
    score: calculateScore(p.cards, p.chips),
  }));
  const bestScore = Math.min(...scores.map((entry) => entry.score));
  const winners = scores.filter((entry) => entry.score === bestScore);
  const winnerNames = winners
    .map((entry) => findPlayer(room, entry.id)?.name ?? "Player")
    .join(", ");
  addEvent(room, `Game finished. Winner: ${winnerNames} (${bestScore}).`);
}

function addEvent(room: Room, message: string): void {
  room.events.push({
    timestamp: Date.now(),
    message,
  });
  if (room.events.length > MAX_EVENTS) {
    room.events.splice(0, room.events.length - MAX_EVENTS);
  }
}

function sanitizeRoom(room: Room): SanitizedRoom {
  const players = room.players.map((player, index) => {
    const cards = [...player.cards].sort((a, b) => a - b);
    return {
      id: player.id,
      name: player.name,
      chips: player.chips,
      cards,
      score: calculateScore(cards, player.chips),
      connected: player.connected,
      isHost: player.id === room.hostId,
      isTurn: room.turnIndex === index && room.state === "inProgress",
    };
  });

  const winnerIds =
    room.state === "finished" ? computeWinnerIds(players) : [];

  return {
    roomId: room.id,
    state: room.state,
    players,
    pot: room.pot,
    currentCard: room.currentCard,
    deckCount: room.deck.length,
    removedCount: room.removedCards.length,
    hostId: room.hostId,
    winnerIds,
    events: room.events.slice(-15),
  };
}

function broadcastState(roomId: string): void {
  const room = rooms.get(roomId);
  if (!room) {
    return;
  }
  io.to(roomId).emit("stateUpdate", sanitizeRoom(room));
}

function cleanupRoomIfEmpty(roomId: string): void {
  const room = rooms.get(roomId);
  if (!room) {
    return;
  }
  if (room.players.length === 0) {
    rooms.delete(roomId);
  }
}

function equalsIgnoreCase(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
}

function generatePlayerId(room: Room, name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "player";

  let attempt = 0;
  while (attempt < 5) {
    const suffix = Math.random().toString(36).slice(2, 6);
    const candidate = `${base}-${suffix}`;
    const exists = room.players.some((player) => player.id === candidate);
    if (!exists) {
      return candidate;
    }
    attempt += 1;
  }
  return `${base}-${Date.now()}`;
}
