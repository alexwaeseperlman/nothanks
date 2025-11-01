# No Thanks Online

This is a lightweight real-time implementation of the card game *No Thanks!* powered by Node.js, Express, and Socket.IO.

## Getting Started

```bash
npm install
npm run start
```

By default the server listens on port `3000`. With the server running, open <http://localhost:3000/> in a browser.

## Creating & Joining Games

- Visit `/` and choose **Create Random Room** or enter a custom room code.
- Share the URL in the form `/room/<room-code>` with your friends so they can join the same table.
- Enter a display name and click **Join Game**. Rejoin later with the same name to reclaim your seat.

## Playing

- The lobby host (the first player in the room) can start the game once at least two players are present.
- Gameplay follows the classic rules: pay a chip to pass (`No Thanks`) or take the current card and any chips on it.
- Scores update live; when the deck is exhausted the game ends and the lowest total wins.

## Development Notes

- The frontend is a static bundle served from `public/` and communicates with the server over Socket.IO.
- Game state is managed on the server in `server/index.js`. Room identifiers are derived from the URL.
- Feel free to tweak styling in `public/styles.css` or extend the UI in `public/client.js`.

## Bot Arena API

Automate your own No Thanks bot via the Socket.IO namespace at `/bots`.

1. Connect using the Socket.IO client and emit `registerBot` once:

   ```js
   import { io } from "socket.io-client";

   const socket = io("/bots");
   socket.emit("registerBot", { name: "MyBot" }, (ack) => {
     if (!ack.ok) {
       console.error("Registration failed:", ack.error);
     } else {
       console.log("Ready! rating =", ack.rating);
     }
   });
   ```

2. Wait for `turn` events. Each payload contains the current card, pot, deck information, and your bot’s cards/chips. Reply with `botAction`:

   ```js
   socket.on("turn", (state) => {
     const { matchId } = state;
     const action = Math.random() < 0.5 ? "pass" : "take";
     socket.emit("botAction", { matchId, action }); // action: "pass" or "take"
   });
   ```

3. After every update you’ll also receive `matchUpdate` snapshots. When a game ends, a `matchEnded` event includes standings and the winners.

Bots automatically queue into matches against other connected bots. Ratings are Elo-based and update after each game. View the live ladder at `/bots` or pull JSON stats from `/api/bots/ratings`.

### Included Bots

- `bots/exampleBot.js` — deliberately simple heuristic-runner useful for smoke tests.
- `bots/smartBot.js` — a stronger bot that weighs score deltas, evaluates whether opponents are likely to take a card, and simulates passing loops before choosing an action. Run it with:

  ```bash
  BOT_NAME=Smartie BOT_COUNT=2 node bots/smartBot.js
  ```

- `npm run demo` spins up the server on a temporary port and launches a trio of smart bots to play a few games automatically (set `DEMO_BOT_SCRIPT` to switch implementations).
