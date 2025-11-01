"use strict";
const container = document.getElementById("bot-app");
renderLoading();
fetchAndRender();
const REFRESH_INTERVAL = 5000;
let refreshTimer = window.setInterval(fetchAndRender, REFRESH_INTERVAL);
document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
        window.clearInterval(refreshTimer);
    }
    else {
        fetchAndRender();
        refreshTimer = window.setInterval(fetchAndRender, REFRESH_INTERVAL);
    }
});
async function fetchAndRender() {
    try {
        const response = await fetch("/api/bots/ratings", { cache: "no-store" });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const data = (await response.json());
        renderLeaderboard(data);
    }
    catch (error) {
        renderError(error instanceof Error ? error : new Error("Unknown error"));
    }
}
function renderLoading() {
    container.innerHTML = `
    <div class="view">
      <h1>Bot Arena Leaderboard</h1>
      <div class="card">
        <p>Loading stats…</p>
      </div>
      <p><a href="/">Back to game</a></p>
    </div>
  `;
}
function renderError(error) {
    container.innerHTML = `
    <div class="view">
      <h1>Bot Arena Leaderboard</h1>
      <div class="card">
        <p class="alert alert-error">Could not load bot stats. ${escapeHtml(error.message)}</p>
        <button id="retry-btn" type="button">Retry</button>
      </div>
      <p><a href="/">Back to game</a></p>
    </div>
  `;
    document.getElementById("retry-btn")?.addEventListener("click", () => {
        renderLoading();
        fetchAndRender();
    });
}
function renderLeaderboard(bots) {
    const rows = bots
        .map((bot, index) => {
        const winRate = bot.games ? `${Math.round(bot.winRate * 100)}%` : "—";
        return `
        <tr>
          <td>${index + 1}</td>
          <td>${escapeHtml(bot.name)}</td>
          <td>${bot.rating}</td>
          <td>${bot.games}</td>
          <td>${bot.wins}</td>
          <td>${bot.losses}</td>
          <td>${bot.draws}</td>
          <td>${winRate}</td>
          <td>${formatRelativeTime(bot.lastSeen)}</td>
        </tr>
      `;
    })
        .join("");
    container.innerHTML = `
    <div class="view">
      <h1>Bot Arena Leaderboard</h1>
      <div class="card">
        <p>Connect your bot via Socket.IO and challenge others. Ratings update after every game.</p>
        <div class="scroll-table">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Name</th>
                <th>Rating</th>
                <th>Games</th>
                <th>Wins</th>
                <th>Losses</th>
                <th>Draws</th>
                <th>Win Rate</th>
                <th>Last Seen</th>
              </tr>
            </thead>
            <tbody>
              ${rows || `<tr><td colspan="9">No bots have competed yet.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
      <p><a href="/">Back to game</a></p>
    </div>
  `;
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
function formatRelativeTime(timestamp) {
    if (!timestamp) {
        return "—";
    }
    const delta = Date.now() - timestamp;
    if (delta < 0) {
        return "just now";
    }
    const seconds = Math.floor(delta / 1000);
    if (seconds < 60) {
        return "just now";
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `${minutes} min ago`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return `${hours} hr${hours === 1 ? "" : "s"} ago`;
    }
    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? "" : "s"} ago`;
}
