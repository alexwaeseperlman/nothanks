/* eslint-disable no-console */
import path from "path";
import { spawn } from "child_process";

const PORT = Number.parseInt(process.env.DEMO_PORT || "4100", 10);
const BOT_COUNT = Number.parseInt(process.env.DEMO_BOT_COUNT || "3", 10);
const DEMO_DURATION_MS = Number.parseInt(process.env.DEMO_DURATION_MS || "8000", 10);
const BOT_SCRIPT = process.env.DEMO_BOT_SCRIPT || "dist/bots/smartBot.js";

const rootDir = path.join(__dirname, "..", "..");

type SpawnOptions = {
  env?: NodeJS.ProcessEnv;
};

function spawnProcess(command: string, args: string[], options: SpawnOptions = {}) {
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

async function runDemo(): Promise<void> {
  console.log(`[demo] Starting server on port ${PORT}`);
  const server = spawnProcess("node", ["dist/server/index.js"], {
    env: { PORT: String(PORT) },
  });

  await waitFor(2000);

  console.log(`[demo] Launching ${BOT_COUNT} bots via ${BOT_SCRIPT}`);
  const bots = spawnProcess("node", [BOT_SCRIPT], {
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

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

runDemo().catch((error) => {
  console.error("[demo] Unexpected error:", error);
  process.exitCode = 1;
});
