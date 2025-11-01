/* eslint-disable no-console */
const path = require("path");
const { spawn } = require("child_process");

const PORT = Number.parseInt(process.env.DEMO_PORT || "4100", 10);
const BOT_COUNT = Number.parseInt(process.env.DEMO_BOT_COUNT || "3", 10);
const DEMO_DURATION_MS = Number.parseInt(process.env.DEMO_DURATION_MS || "8000", 10);

const rootDir = path.join(__dirname, "..");

function spawnProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: rootDir,
    env: { ...process.env, ...options.env },
    stdio: "inherit",
  });
  child.on("error", (error) => {
    console.error(`[demo] Failed to start ${command}:`, error);
  });
  return child;
}

async function runDemo() {
  console.log(`[demo] Starting server on port ${PORT}`);
  const server = spawnProcess("node", ["server/index.js"], {
    env: { PORT: String(PORT) },
  });

  await waitFor(2000);

  const botScript = process.env.DEMO_BOT_SCRIPT || "bots/smartBot.js";
  console.log(`[demo] Launching ${BOT_COUNT} bots via ${botScript}`);
  const bots = spawnProcess("node", [botScript], {
    env: {
      BOT_SERVER_URL: `http://localhost:${PORT}`,
      BOT_COUNT: String(BOT_COUNT),
      BOT_NAME: "DemoSmart",
    },
  });

  await waitFor(DEMO_DURATION_MS);

  console.log("[demo] Stopping bots and server…");
  bots.kill("SIGINT");
  server.kill("SIGINT");

  await waitFor(1000);
  console.log("[demo] Done");
}

function waitFor(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

runDemo().catch((error) => {
  console.error("[demo] Unexpected error:", error);
  process.exitCode = 1;
});
