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
- Enter a display name and click **Join Game**. Your name and seat are remembered in the browser so reconnecting is seamless.

## Playing

- The lobby host (the first player in the room) can start the game once at least two players are present.
- Gameplay follows the classic rules: pay a chip to pass (`No Thanks`) or take the current card and any chips on it.
- Scores update live; when the deck is exhausted the game ends and the lowest total wins.

## Development Notes

- The frontend is a static bundle served from `public/` and communicates with the server over Socket.IO.
- Game state is managed on the server in `server/index.js`. Room identifiers are derived from the URL.
- Feel free to tweak styling in `public/styles.css` or extend the UI in `public/client.js`.
