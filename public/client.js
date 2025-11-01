const socket = io();

const appEl = document.getElementById("app");

const state = {
  connected: socket.connected,
  room: null,
  hasJoined: false,
  playerId: null,
  name: "",
  joinError: "",
  generalError: "",
  joinInFlight: false,
};

let errorTimeout = null;

const roomInfo = parseRoomFromLocation();

socket.on("connect", () => {
  state.connected = true;
  if (roomInfo.roomId && state.hasJoined && state.name) {
    joinRoom(state.name, { suppressError: true });
  }
  render();
});

socket.on("disconnect", () => {
  state.connected = false;
  render();
});

socket.on("stateUpdate", (roomState) => {
  state.room = roomState;
  attachPlayerNameFromState();
  render();
});

socket.on("errorMessage", (message) => {
  showTransientError(message);
});

function parseRoomFromLocation() {
  const match = window.location.pathname.match(/^\/room\/([a-zA-Z0-9_-]{1,32})$/);
  if (match) {
    return { roomId: match[1] };
  }
  return { roomId: null };
}

function render() {
  if (!roomInfo.roomId) {
    renderLanding();
    return;
  }

  if (!state.hasJoined) {
    renderJoin();
    return;
  }

  renderGame();
}

function renderLanding() {
  appEl.innerHTML = `
    <div class="view view-landing">
      <h1>No Thanks Online</h1>
      <p>Create a new table or jump back into a room.</p>
      <div class="card">
        <button id="create-room" type="button">Create Random Room</button>
      </div>
      <div class="card">
        <form id="join-room-form">
          <label for="room-input">Room code (letters, numbers, - or _)</label>
          <div class="input-row">
            <input id="room-input" name="room" placeholder="my-friends" autocomplete="off" value="" />
            <button type="submit">Go</button>
          </div>
        </form>
      </div>
    </div>
  `;

  const createBtn = document.getElementById("create-room");
  const joinForm = document.getElementById("join-room-form");

  createBtn?.addEventListener("click", () => {
    const roomId = generateRoomId();
    navigateToRoom(roomId);
  });

  joinForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const roomInput = document.getElementById("room-input");
    const rawValue = `${roomInput?.value || ""}`.trim();
    if (!rawValue) {
      showTransientError("Enter a room code.");
      return;
    }
    const normalized = normalizeRoomCode(rawValue);
    navigateToRoom(normalized);
  });
}

function renderJoin() {
  const statusLine = state.connected ? "Connected to server." : "Reconnecting...";
  appEl.innerHTML = `
    <div class="view view-join">
      <h1>Room: ${escapeHtml(roomInfo.roomId)}</h1>
      <p>${escapeHtml(statusLine)}</p>
      ${
        state.joinError
          ? `<div class="alert alert-error">${escapeHtml(state.joinError)}</div>`
          : ""
      }
      <div class="card">
        <form id="join-form">
          <label for="name-input">Display name</label>
          <input id="name-input" name="name" placeholder="Your name" maxlength="24" autocomplete="off" value="${escapeHtml(
            state.name,
          )}" />
          <button type="submit"${!state.connected ? " disabled" : ""}>
            ${state.joinInFlight ? "Joining..." : "Join Game"}
          </button>
        </form>
      </div>
      <p class="back-link"><a href="/">Back to home</a></p>
      ${renderGeneralError()}
    </div>
  `;

  const joinForm = document.getElementById("join-form");
  const nameInput = document.getElementById("name-input");
  nameInput?.focus();

  joinForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!state.connected) {
      showTransientError("Still connecting. Try again in a moment.");
      return;
    }
    const name = `${nameInput?.value || ""}`.trim();
    if (!name) {
      state.joinError = "Name is required.";
      render();
      return;
    }
    state.joinError = "";
    joinRoom(name);
  });
}

function renderGame() {
  const room = state.room;
  const players = room?.players || [];
  const me = players.find((player) => player.id === state.playerId) || null;
  const winnerNames = (room?.winnerIds || [])
    .map((id) => players.find((player) => player.id === id)?.name || "Player")
    .filter(Boolean);

  const isHost = room?.hostId === state.playerId;
  const canStart = room?.state !== "inProgress" && players.length >= 2 && isHost;
  const canPass = room?.state === "inProgress" && me?.isTurn && (me?.chips || 0) > 0;
  const canTake = room?.state === "inProgress" && me?.isTurn;
  const waitingForPlayers = room?.state === "lobby" && players.length < 2;
  const waitingForHost = room?.state === "lobby" && !isHost;

  appEl.innerHTML = `
    <div class="view view-game">
      <header class="toolbar">
        <div>
          <strong>Room:</strong> ${escapeHtml(roomInfo.roomId)}
        </div>
        <div class="status-line">
          ${state.connected ? "Online" : "Offline"}
          ${state.connected ? "" : '<span class="subtle">(attempting to reconnect)</span>'}
        </div>
      </header>

      ${renderGeneralError()}

      ${
        room?.state === "finished"
          ? `<div class="alert alert-success">Game over! Winner: ${escapeHtml(
              winnerNames.join(", ") || "Unknown",
            )}</div>`
          : ""
      }

      <section class="card focus-card">
        <h2>Current Card</h2>
        <div class="focus-values">
          <div class="main-value">${room?.currentCard ?? "—"}</div>
          <div class="meta">
            <span>Pot: ${room?.pot ?? 0}</span>
            <span>Deck: ${room?.deckCount ?? 0} left</span>
            <span>Hidden: ${room?.removedCount ?? 0}</span>
          </div>
        </div>
        ${
          room?.state === "lobby"
            ? `<p class="helper-text">
                ${
                  waitingForPlayers && isHost
                    ? "Share this room link with a friend. Once two players are present you can press Start Game."
                    : waitingForHost
                      ? "Waiting for the host to start the game."
                      : isHost
                        ? "Ready when you are—hit Start Game to deal the first card."
                        : "Sit tight! The game will begin as soon as the host starts it."
                }
              </p>`
            : ""
        }
        <div class="actions">
          <button data-action="pass"${!canPass ? " disabled" : ""}>No Thanks (-1 chip)</button>
          <button data-action="take"${!canTake ? " disabled" : ""}>Take Card</button>
        </div>
        ${
          canStart
            ? `<button id="start-game" class="primary">Start Game</button>`
            : ""
        }
        ${
          room?.state === "finished" && isHost
            ? `<button id="restart-game" class="primary">Play Again</button>`
            : ""
        }
      </section>

      <section class="card players-card">
        <h2>Players</h2>
        <div class="player-list">
          ${players
            .map((player) => renderPlayerRow(player))
            .join("")}
        </div>
      </section>

      <section class="card log-card">
        <h2>Table Log</h2>
        <ul class="log">
          ${(room?.events || [])
            .slice()
            .reverse()
            .map((entry) => `<li>${formatTimestamp(entry.timestamp)} — ${escapeHtml(entry.message)}</li>`)
            .join("") || "<li>No activity yet.</li>"}
        </ul>
      </section>
    </div>
  `;

  const passBtn = document.querySelector("[data-action='pass']");
  const takeBtn = document.querySelector("[data-action='take']");
  const startBtn = document.getElementById("start-game");
  const restartBtn = document.getElementById("restart-game");

  passBtn?.addEventListener("click", () => triggerAction("pass"));
  takeBtn?.addEventListener("click", () => triggerAction("take"));
  startBtn?.addEventListener("click", () => socket.emit("startGame"));
  restartBtn?.addEventListener("click", () => socket.emit("startGame"));
}

function renderPlayerRow(player) {
  const badges = [
    player.isHost ? '<span class="badge">Host</span>' : "",
    player.isTurn ? '<span class="badge badge-active">Turn</span>' : "",
    !player.connected ? '<span class="badge badge-muted">Offline</span>' : "",
  ]
    .filter(Boolean)
    .join("");
  const cards = player.cards.length ? player.cards.join(", ") : "—";
  const scoreLine = `Score: ${player.score}`;

  return `
    <div class="player-row${player.isTurn ? " current" : ""}">
      <div class="player-meta">
        <span class="player-name">${escapeHtml(player.name)}</span>
        <span class="badges">${badges}</span>
      </div>
      <div class="player-stats">
        <span>Chips: ${player.chips}</span>
        <span>Cards: ${cards}</span>
        <span>${scoreLine}</span>
      </div>
    </div>
  `;
}

function renderGeneralError() {
  if (!state.generalError) {
    return "";
  }
  return `<div class="alert alert-error">${escapeHtml(state.generalError)}</div>`;
}

function joinRoom(name, options = {}) {
  if (!roomInfo.roomId || state.joinInFlight) {
    return;
  }
  state.joinInFlight = true;
  state.joinError = "";
  render();
  const payload = {
    roomId: roomInfo.roomId,
    name,
    playerId: state.playerId || null,
  };

  const sendJoin = () => {
    socket.emit("joinRoom", payload, (response) => {
      state.joinInFlight = false;
      if (!response?.ok) {
        if (!options.suppressError) {
          state.joinError = "Could not join room.";
        }
        render();
        return;
      }
      state.hasJoined = true;
      state.playerId = response.playerId;
      state.room = response.state;
      state.name = name;
      state.joinError = "";
      attachPlayerNameFromState();
      render();
    });
  };

  if (!socket.connected) {
    socket.once("connect", sendJoin);
  } else {
    sendJoin();
  }
}

function triggerAction(action) {
  socket.emit("playerAction", { action });
}

function attachPlayerNameFromState() {
  if (!state.room || !state.playerId) {
    return;
  }
  const me = state.room.players.find((player) => player.id === state.playerId);
  if (me) {
    state.name = me.name;
  }
}

function showTransientError(message) {
  state.generalError = message;
  render();
  if (errorTimeout) {
    window.clearTimeout(errorTimeout);
  }
  errorTimeout = window.setTimeout(() => {
    if (state.generalError === message) {
      state.generalError = "";
      render();
    }
  }, 4000);
}

function formatTimestamp(timestamp) {
  if (!timestamp) {
    return "";
  }
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function generateRoomId() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 6; i += 1) {
    result += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return result;
}

function normalizeRoomCode(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function navigateToRoom(roomId) {
  window.location.href = `/room/${encodeURIComponent(roomId)}`;
}

function escapeHtml(str) {
  return `${str}`.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#039;";
      default:
        return ch;
    }
  });
}

render();
