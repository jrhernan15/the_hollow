"use strict";
/* =========================================================================
   THE HOLLOW — ordering API  (The Pass / The Rail / Rounds)
   -------------------------------------------------------------------------
   A tiny Node + SQLite service. Guests POST tickets onto The Rail; the
   bartender fires same-drink tickets into a Round; everyone gets live updates
   over Server-Sent Events. No framework — just Node's http + better-sqlite3.

   Env:
     PORT       (default 3000)        HOST   (default 127.0.0.1)
     HOLLOW_DB  (default ../data/hollow.db)
   ========================================================================= */

const http = require("http");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const DB_PATH = process.env.HOLLOW_DB || path.join(__dirname, "..", "data", "hollow.db");
const CODE = process.env.HOLLOW_CODE || "5352";   // passcode for The 86 (stock) edits

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS rounds (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    drink      TEXT    NOT NULL,
    count      INTEGER NOT NULL DEFAULT 0,
    status     TEXT    NOT NULL DEFAULT 'working',   -- working | up | served
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS tickets (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    drink      TEXT    NOT NULL,
    guest_name TEXT,
    notes      TEXT,
    qty        INTEGER NOT NULL DEFAULT 1,
    status     TEXT    NOT NULL DEFAULT 'rail',       -- rail | working | up | served
    round_id   INTEGER REFERENCES rounds(id) ON DELETE SET NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migrate older databases that predate the qty column.
try {
  const cols = db.prepare("PRAGMA table_info(tickets)").all().map((c) => c.name);
  if (!cols.includes("qty")) db.exec("ALTER TABLE tickets ADD COLUMN qty INTEGER NOT NULL DEFAULT 1");
} catch (e) {}

// The 86: ingredients currently marked out of stock (hides drinks that need them).
db.exec(`CREATE TABLE IF NOT EXISTS eighty_six ( ingredient TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (datetime('now')) );`);
// Shared settings (e.g. the active theme).
db.exec(`CREATE TABLE IF NOT EXISTS settings ( key TEXT PRIMARY KEY, value TEXT );`);
// The Ledger: a persistent log of every drink actually poured (one row per
// ticket, written when its round is marked Ready). Survives board resets.
db.exec(`CREATE TABLE IF NOT EXISTS history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  drink      TEXT    NOT NULL,
  qty        INTEGER NOT NULL DEFAULT 1,
  guest      TEXT,
  round_id   INTEGER,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);`);
// The Wall: short party notes / toasts. Persists; "tonight" is a created_at filter.
db.exec(`CREATE TABLE IF NOT EXISTS wall (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT    NOT NULL,
  name       TEXT,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);`);
// Reactions: one per device (cid) per drink; tap to set/switch/clear.
// Reactions ("The Verdict"): one row per device (cid) per drink per emoji — multi-select.
db.exec(`CREATE TABLE IF NOT EXISTS reactions (
  cid         TEXT NOT NULL,
  drink       TEXT NOT NULL,
  emoji       TEXT NOT NULL,
  night_start TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  PRIMARY KEY (cid, drink, emoji, night_start)
);`);
// One-time migration: older DBs keyed reactions by (cid, drink) — one emoji per person.
// Rebuild with emoji in the primary key so a person can pick more than one.
{
  const _ri = db.prepare("PRAGMA table_info(reactions)").all();
  const _emoji = _ri.find((c) => c.name === "emoji");
  if (!_emoji || _emoji.pk === 0) {
    db.exec("DROP TABLE IF EXISTS reactions");
    db.exec("CREATE TABLE reactions (cid TEXT NOT NULL, drink TEXT NOT NULL, emoji TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')), PRIMARY KEY (cid, drink, emoji))");
  }
}
// One-time migration: stamp reactions with the night they were cast, so drinks keep
// lifetime reactions while a device can react once per drink per night (fresh each night).
// Existing rows get night_start='' — they count toward all-time, never toward "tonight".
{
  const _ri = db.prepare("PRAGMA table_info(reactions)").all();
  if (!_ri.some((c) => c.name === "night_start")) {
    db.exec("ALTER TABLE reactions RENAME TO reactions_old");
    db.exec("CREATE TABLE reactions (cid TEXT NOT NULL, drink TEXT NOT NULL, emoji TEXT NOT NULL, night_start TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')), PRIMARY KEY (cid, drink, emoji, night_start))");
    db.exec("INSERT OR IGNORE INTO reactions (cid, drink, emoji, night_start, created_at) SELECT cid, drink, emoji, '', created_at FROM reactions_old");
    db.exec("DROP TABLE reactions_old");
  }
}
// Order cancellations: when the bar pulls a guest's order, a short-lived record
// so that guest's device can notify them (and stop asking for a rating).
db.exec(`CREATE TABLE IF NOT EXISTS cancellations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  INTEGER NOT NULL,
  drink      TEXT NOT NULL,
  guest      TEXT,
  reason     TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);`);

// The Parlour: live party games. One game runs at a time; meta + toggles live in
// a single settings JSON ('parlour'); these tables hold the roster, per-round
// answers, and guest/host-added prompts.
db.exec(`CREATE TABLE IF NOT EXISTS parlour_players (
  cid TEXT PRIMARY KEY, name TEXT,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now'))
);`);
db.exec(`CREATE TABLE IF NOT EXISTS parlour_answers (
  round INTEGER NOT NULL, cid TEXT NOT NULL, value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (round, cid)
);`);
db.exec(`CREATE TABLE IF NOT EXISTS parlour_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, game TEXT NOT NULL, text TEXT NOT NULL,
  spicy INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);

const Q = {
  insertTicket:  db.prepare("INSERT INTO tickets (drink, guest_name, notes, qty) VALUES (?,?,?,?)"),
  getTicket:     db.prepare("SELECT * FROM tickets WHERE id = ?"),
  railTickets:   db.prepare("SELECT * FROM tickets WHERE status = 'rail' ORDER BY created_at, id"),
  deleteTicket:  db.prepare("DELETE FROM tickets WHERE id = ?"),
  railTicket:    db.prepare("UPDATE tickets SET round_id = NULL, status = 'rail', updated_at = datetime('now') WHERE id = ?"),
  roundTixCount: db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE round_id = ?"),
  insertRound:   db.prepare("INSERT INTO rounds (drink, count) VALUES (?, ?)"),
  getRound:      db.prepare("SELECT * FROM rounds WHERE id = ?"),
  allRounds:     db.prepare("SELECT * FROM rounds ORDER BY created_at, id"),
  roundTickets:  db.prepare("SELECT * FROM tickets WHERE round_id = ? ORDER BY id"),
  fireTicket:    db.prepare("UPDATE tickets SET round_id = ?, status = 'working', updated_at = datetime('now') WHERE id = ?"),
  setRoundStat:  db.prepare("UPDATE rounds SET status = ?, updated_at = datetime('now') WHERE id = ?"),
  cascade:       db.prepare("UPDATE tickets SET status = ?, updated_at = datetime('now') WHERE round_id = ?"),
  disband:       db.prepare("UPDATE tickets SET round_id = NULL, status = 'rail', updated_at = datetime('now') WHERE round_id = ?"),
  deleteRound:   db.prepare("DELETE FROM rounds WHERE id = ?"),
  deleteRoundTickets: db.prepare("DELETE FROM tickets WHERE round_id = ?"),
  clearTickets:  db.prepare("DELETE FROM tickets"),
  clearRounds:   db.prepare("DELETE FROM rounds"),
  clearServedTix: db.prepare("DELETE FROM tickets WHERE round_id IN (SELECT id FROM rounds WHERE status = 'served')"),
  clearServedRnd: db.prepare("DELETE FROM rounds WHERE status = 'served'"),
  all86:   db.prepare("SELECT ingredient FROM eighty_six ORDER BY ingredient"),
  set86:   db.prepare("INSERT OR IGNORE INTO eighty_six (ingredient) VALUES (?)"),
  unset86: db.prepare("DELETE FROM eighty_six WHERE ingredient = ?"),
  clear86: db.prepare("DELETE FROM eighty_six"),
  getSetting: db.prepare("SELECT value FROM settings WHERE key = ?"),
  setSetting: db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
  nowStr:        db.prepare("SELECT strftime('%Y-%m-%d %H:%M:%f','now') AS t"),

  // The Parlour
  parlourUpsertPlayer: db.prepare("INSERT INTO parlour_players (cid, name) VALUES (?, ?) ON CONFLICT(cid) DO UPDATE SET name = COALESCE(excluded.name, parlour_players.name), last_seen = datetime('now')"),
  parlourPlayers:      db.prepare("SELECT cid, name FROM parlour_players ORDER BY joined_at, cid"),
  parlourClearPlayers: db.prepare("DELETE FROM parlour_players"),
  parlourSetAnswer:    db.prepare("INSERT INTO parlour_answers (round, cid, value) VALUES (?, ?, ?) ON CONFLICT(round, cid) DO UPDATE SET value = excluded.value, created_at = datetime('now')"),
  parlourRoundSplit:   db.prepare("SELECT value, COUNT(*) AS n FROM parlour_answers WHERE round = ? GROUP BY value"),
  parlourRoundCount:   db.prepare("SELECT COUNT(*) AS n FROM parlour_answers WHERE round = ?"),
  parlourClearAnswers: db.prepare("DELETE FROM parlour_answers"),
  parlourAddPrompt:    db.prepare("INSERT INTO parlour_prompts (game, text, spicy) VALUES (?, ?, ?)"),
  parlourPrompts:      db.prepare("SELECT text, spicy FROM parlour_prompts WHERE game = ?"),
  parlourClearPrompts: db.prepare("DELETE FROM parlour_prompts"),
  insertHistory: db.prepare("INSERT INTO history (drink, qty, guest, round_id) VALUES (?,?,?,?)"),
  historyRows:   db.prepare("SELECT drink, qty, guest, round_id, created_at FROM history ORDER BY created_at, id"),
  historyHasRoundDrink:    db.prepare("SELECT 1 FROM history WHERE round_id = ? AND drink = ? LIMIT 1"),
  deleteHistoryRoundDrink: db.prepare("DELETE FROM history WHERE round_id = ? AND drink = ?"),
  deleteHistoryRound:      db.prepare("DELETE FROM history WHERE round_id = ?"),
  insertCancellation:  db.prepare("INSERT INTO cancellations (ticket_id, drink, guest, reason) VALUES (?,?,?,?)"),
  recentCancellations: db.prepare("SELECT id, ticket_id, drink, guest, reason, created_at FROM cancellations WHERE created_at >= strftime('%Y-%m-%d %H:%M:%f','now','-30 minutes') ORDER BY id DESC LIMIT 50"),
  clearCancellations:  db.prepare("DELETE FROM cancellations"),
  clearHistory:  db.prepare("DELETE FROM history"),
  insertWall: db.prepare("INSERT INTO wall (text, name) VALUES (?, ?)"),
  wallRows:   db.prepare("SELECT id, text, name, created_at FROM wall ORDER BY created_at DESC, id DESC"),
  deleteWall: db.prepare("DELETE FROM wall WHERE id = ?"),
  clearWall:  db.prepare("DELETE FROM wall"),
  setReaction:    db.prepare("INSERT OR IGNORE INTO reactions (cid, drink, emoji, night_start) VALUES (?,?,?,?)"),
  clearReaction:  db.prepare("DELETE FROM reactions WHERE cid = ? AND drink = ? AND emoji = ? AND night_start = ?"),
  reactionCounts: db.prepare("SELECT drink, emoji, COUNT(*) AS n FROM reactions GROUP BY drink, emoji"),
  reactionCountsNight: db.prepare("SELECT drink, emoji, COUNT(*) AS n FROM reactions WHERE night_start = ? GROUP BY drink, emoji"),
  clearReactions: db.prepare("DELETE FROM reactions"),
  markDrinkUp:      db.prepare("UPDATE tickets SET status='up', updated_at=datetime('now') WHERE round_id = ? AND drink = ?"),
  markDrinkWorking: db.prepare("UPDATE tickets SET status='working', updated_at=datetime('now') WHERE round_id = ? AND drink = ?"),
  roundNotUpCount:  db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE round_id = ? AND status != 'up'"),
  roundDrinks:      db.prepare("SELECT DISTINCT drink FROM tickets WHERE round_id = ?"),
  roundTixByDrink:  db.prepare("SELECT * FROM tickets WHERE round_id = ? AND drink = ?"),
};

// Log one drink of a round to the Ledger exactly once (deduped by round_id +
// drink, so re-checking the same drink never double-counts). One row per ticket
// so each guest is preserved.
function logRoundDrink(roundId, drink) {
  if (Q.historyHasRoundDrink.get(roundId, drink)) return;
  const tix = Q.roundTixByDrink.all(roundId, drink);
  db.transaction(() => {
    for (const t of tix) Q.insertHistory.run(t.drink, t.qty || 1, t.guest_name || null, roundId);
  })();
}

// After a round's tickets change (one pulled to the rail or removed), refresh its
// status — or delete the round if it's now empty.
function recomputeRound(roundId) {
  if (roundId == null) return;
  if (Q.roundTixCount.get(roundId).n === 0) { Q.deleteRound.run(roundId); return; }
  Q.setRoundStat.run(Q.roundNotUpCount.get(roundId).n === 0 ? "up" : "working", roundId);
}

// The Ledger's "tonight" window resets automatically at 4 AM Eastern each day
// (handles EST/EDT). Returns the most recent 4 AM ET as a UTC string matching
// the history.created_at format, so "tonight" = rows >= this.
const RESET_HOUR = 4, RESET_TZ = "America/New_York";
function zoneParts(instant) {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: RESET_TZ, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const m = {}; for (const p of dtf.formatToParts(instant)) m[p.type] = p.value;
  if (m.hour === "24") m.hour = "00";
  return m;
}
function zoneOffsetMs(instant) {
  const m = zoneParts(instant);
  return Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour, +m.minute, +m.second) - instant.getTime();
}
function etWallToUTC(y, mo, d, h) {
  const guess = Date.UTC(y, mo, d, h, 0, 0);
  let utc = guess - zoneOffsetMs(new Date(guess));
  return new Date(guess - zoneOffsetMs(new Date(utc)));   // refine once for DST edges
}
function dbFmt(d) {
  const p = (n, l = 2) => String(n).padStart(l, "0");
  return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) + " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + ":" + p(d.getUTCSeconds()) + "." + p(d.getUTCMilliseconds(), 3);
}
function lastResetUTC(now) {
  const m = zoneParts(now);
  let y = +m.year, mo = +m.month - 1, d = +m.day, h = +m.hour;
  if (h < RESET_HOUR) { const ydy = new Date(Date.UTC(y, mo, d) - 86400000); return dbFmt(etWallToUTC(ydy.getUTCFullYear(), ydy.getUTCMonth(), ydy.getUTCDate(), RESET_HOUR)); }
  return dbFmt(etWallToUTC(y, mo, d, RESET_HOUR));
}

/* ---- The Parlour (live party games) ---- */
// Starter prompt packs. Deliberately small for v1 — we expand these after the
// mechanics land. Guests/host can also add their own via /api/parlour/prompt.
const PARLOUR_PROMPTS = {
  confession: {
    tame: [
      "Never have I ever fallen asleep at a party.",
      "Never have I ever sent a text to entirely the wrong person.",
      "Never have I ever ghosted a group chat to dodge plans.",
      "Never have I ever forgotten someone's name mid-introduction.",
      "Never have I ever pretended to have read a book I hadn't.",
      "Never have I ever re-gifted a present.",
      "Never have I ever cried at a TV commercial.",
      "Never have I ever binged a whole series in one sitting.",
      "Never have I ever rehearsed a conversation in the shower.",
      "Never have I ever laughed at completely the wrong moment.",
      "Never have I ever googled my own name.",
      "Never have I ever left a party without saying goodbye.",
      "Never have I ever eaten dessert for dinner.",
      "Never have I ever pretended my phone was dying to end a call.",
    ],
    spicy: [
      "Never have I ever had a crush on a friend's partner.",
      "Never have I ever snooped in someone's medicine cabinet.",
      "Never have I ever texted an ex after midnight.",
      "Never have I ever looked up an ex on social media this week.",
      "Never have I ever lied about my age.",
      "Never have I ever pretended to be busy to avoid someone in this room.",
      "Never have I ever kept a secret from everyone here tonight.",
      "Never have I ever had a work crush.",
      "Never have I ever sworn in front of someone's parents.",
    ],
  },
};
const PARLOUR_DEFAULT = { game: null, phase: "ended", round: 0, prompt: "", dealt: [], spicy: false, advance: "host", showWho: true, scoring: true, startedAt: "" };
function getParlour() {
  const row = Q.getSetting.get("parlour");
  if (!row || !row.value) return { ...PARLOUR_DEFAULT };
  try { return { ...PARLOUR_DEFAULT, ...JSON.parse(row.value) }; } catch (e) { return { ...PARLOUR_DEFAULT }; }
}
function saveParlour(p) { Q.setSetting.run("parlour", JSON.stringify(p)); }
function resetParlour() { Q.parlourClearPlayers.run(); Q.parlourClearAnswers.run(); Q.parlourClearPrompts.run(); saveParlour({ ...PARLOUR_DEFAULT }); }
function dealParlourPrompt(p) {
  const bundled = PARLOUR_PROMPTS[p.game] || { tame: [], spicy: [] };
  let base = (bundled.tame || []).slice();
  if (p.spicy) base = base.concat(bundled.spicy || []);
  const custom = [];   // player/host-submitted — these get priority
  for (const r of Q.parlourPrompts.all(p.game)) { if (!r.spicy || p.spicy) custom.push(r.text); }
  p.dealt = Array.isArray(p.dealt) ? p.dealt : [];
  // Prefer unused player-submitted prompts; fall back to the bundled pack.
  let avail = custom.filter((t) => p.dealt.indexOf(t) === -1);
  if (!avail.length) avail = base.filter((t) => p.dealt.indexOf(t) === -1);
  if (!avail.length) { p.dealt = []; avail = custom.length ? custom.slice() : base.slice(); }  // all used → start over, still preferring custom
  if (!avail.length) return null;
  const pick = avail[Math.floor(Math.random() * avail.length)];
  p.dealt.push(pick);
  return pick;
}
function canAdvance(body) { const p = getParlour(); return p.advance === "anyone" || String(body.code) === CODE; }
function parlourState() {
  const p = getParlour();
  const players = Q.parlourPlayers.all();
  const out = { game: p.game, phase: p.phase, round: p.round || 0, prompt: p.prompt || "", spicy: !!p.spicy, advance: p.advance || "host", showWho: !!p.showWho, scoring: !!p.scoring, players, present: players.length };
  if (p.game && (p.phase === "answer" || p.phase === "reveal")) {
    out.answered = Q.parlourRoundCount.get(p.round).n;
    if (p.phase === "reveal") {
      let have = 0, total = 0;
      for (const r of Q.parlourRoundSplit.all(p.round)) { total += r.n; if (r.value === "have") have = r.n; }
      out.count = { have: have, total: total };
      out.fuzzy = total < 5;   // small groups: show "a few of you", not an exact count
    }
  }
  return out;
}

function currentNightStart() {
  const nsRow = Q.getSetting.get("night_start");
  const manualNS = (nsRow && nsRow.value) || "";
  const autoNS = lastResetUTC(new Date());
  return (manualNS && manualNS > autoNS) ? manualNS : autoNS; // a later manual reset wins
}

function getState() {
  const rail = Q.railTickets.all();
  const rounds = Q.allRounds.all().map((r) => ({ ...r, tickets: Q.roundTickets.all(r.id) }));
  const themeRow = Q.getSetting.get("theme");
  const nightStart = currentNightStart();
  const reactions = {};      // tonight only: drink -> emoji -> # of devices this night
  for (const r of Q.reactionCountsNight.all(nightStart)) { (reactions[r.drink] = reactions[r.drink] || {})[r.emoji] = r.n; }
  const reactionsAll = {};   // lifetime: every night stacked
  for (const r of Q.reactionCounts.all()) { (reactionsAll[r.drink] = reactionsAll[r.drink] || {})[r.emoji] = r.n; }
  return { rail, rounds, eightySix: Q.all86.all().map((r) => r.ingredient), theme: (themeRow && themeRow.value) || "auto", reactions, reactionsAll, nightStart, cancellations: Q.recentCancellations.all(), parlour: parlourState() };
}

/* ---- Server-Sent Events ---- */
const clients = new Set();
function broadcast() {
  const payload = `event: state\ndata: ${JSON.stringify(getState())}\n\n`;
  for (const res of clients) { try { res.write(payload); } catch (_) {} }
}

/* ---- helpers ---- */
const CORS = { "Access-Control-Allow-Origin": "*" };
function sendJSON(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", ...CORS });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}
const str = (v, max) => (v == null ? null : String(v).trim().slice(0, max) || null);

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method;

  if (method === "OPTIONS") {
    res.writeHead(204, { ...CORS, "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
    return res.end();
  }

  try {
    if (pathname === "/api/health" && method === "GET") return sendJSON(res, 200, { ok: true });
    if (pathname === "/api/state"  && method === "GET") return sendJSON(res, 200, getState());

    if (pathname === "/api/stream" && method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", ...CORS });
      res.write("retry: 3000\n\n");
      res.write(`event: state\ndata: ${JSON.stringify(getState())}\n\n`);
      clients.add(res);
      const hb = setInterval(() => { try { res.write(": ping\n\n"); } catch (_) {} }, 25000);
      req.on("close", () => { clearInterval(hb); clients.delete(res); });
      return;
    }

    if (pathname === "/api/tickets" && method === "POST") {
      const b = await readBody(req);
      const drink = str(b.drink, 80);
      if (!drink) return sendJSON(res, 400, { error: "drink is required" });
      const qty = Math.max(1, Math.min(99, parseInt(b.qty, 10) || 1));
      const info = Q.insertTicket.run(drink, str(b.name, 60), str(b.notes, 200), qty);
      broadcast();
      return sendJSON(res, 201, Q.getTicket.get(info.lastInsertRowid));
    }

    let m;
    if ((m = pathname.match(/^\/api\/tickets\/(\d+)$/)) && method === "DELETE") {
      const id = Number(m[1]); const t = Q.getTicket.get(id);
      Q.deleteTicket.run(id);
      if (t) recomputeRound(t.round_id);   // keep the round (or clean it up) in sync
      broadcast();
      return sendJSON(res, 200, { ok: true });
    }

    // Bar pulls a guest's order (with an optional reason) — records a cancellation the
    // guest's device picks up, then removes the ticket.
    if ((m = pathname.match(/^\/api\/tickets\/(\d+)\/cancel$/)) && method === "POST") {
      const id = Number(m[1]); const t = Q.getTicket.get(id);
      const b = await readBody(req);
      if (t) {
        Q.insertCancellation.run(id, t.drink, t.guest_name || null, str(b.reason, 120) || null);
        Q.deleteTicket.run(id);
        recomputeRound(t.round_id);
      }
      broadcast();
      return sendJSON(res, 200, { ok: true });
    }

    // Pull a single ticket out of its round, back to the rail.
    if ((m = pathname.match(/^\/api\/tickets\/(\d+)\/rail$/)) && method === "POST") {
      const id = Number(m[1]); const t = Q.getTicket.get(id);
      if (!t) return sendJSON(res, 404, { error: "ticket not found" });
      const rid = t.round_id;
      Q.railTicket.run(id);
      recomputeRound(rid);
      broadcast();
      return sendJSON(res, 200, { ok: true });
    }

    if (pathname === "/api/rounds" && method === "POST") {
      const b = await readBody(req);
      const ids = Array.isArray(b.ticketIds) ? [...new Set(b.ticketIds.map(Number).filter(Boolean))] : [];
      if (!ids.length) return sendJSON(res, 400, { error: "ticketIds required" });
      const tix = ids.map((id) => Q.getTicket.get(id)).filter(Boolean);
      if (tix.length !== ids.length) return sendJSON(res, 400, { error: "some tickets not found" });
      if (tix.some((t) => t.status !== "rail")) return sendJSON(res, 409, { error: "all tickets must be on the rail" });
      // A round can hold mixed drinks (a table's order, made together).
      const fire = db.transaction(() => {
        const rid = Q.insertRound.run(tix[0].drink, tix.reduce((a, t) => a + (t.qty || 1), 0)).lastInsertRowid;
        for (const t of tix) Q.fireTicket.run(rid, t.id);
        return rid;
      });
      const rid = fire();
      broadcast();
      return sendJSON(res, 201, { ...Q.getRound.get(rid), tickets: Q.roundTickets.all(rid) });
    }

    if ((m = pathname.match(/^\/api\/rounds\/(\d+)$/)) && method === "PATCH") {
      const b = await readBody(req);
      const status = String(b.status || "");
      if (!["working", "up", "served"].includes(status)) return sendJSON(res, 400, { error: "status must be working | up | served" });
      const id = Number(m[1]);
      if (!Q.getRound.get(id)) return sendJSON(res, 404, { error: "round not found" });
      db.transaction(() => { Q.setRoundStat.run(status, id); Q.cascade.run(status, id); })();
      if (status === "up") { for (const r of Q.roundDrinks.all(id)) logRoundDrink(id, r.drink); }   // poured → Ledger
      else if (status === "working") { Q.deleteHistoryRound.run(id); }                              // reopened → un-log
      broadcast();
      return sendJSON(res, 200, { ...Q.getRound.get(id), tickets: Q.roundTickets.all(id) });
    }

    // Check off / un-check a single drink within a round (per-drink readiness).
    if ((m = pathname.match(/^\/api\/rounds\/(\d+)\/mark$/)) && method === "POST") {
      const b = await readBody(req);
      const id = Number(m[1]);
      const drink = str(b.drink, 80);
      if (!Q.getRound.get(id)) return sendJSON(res, 404, { error: "round not found" });
      if (!drink) return sendJSON(res, 400, { error: "drink required" });
      if (b.made) { Q.markDrinkUp.run(id, drink); logRoundDrink(id, drink); }
      else { Q.markDrinkWorking.run(id, drink); Q.deleteHistoryRoundDrink.run(id, drink); }
      const allUp = Q.roundNotUpCount.get(id).n === 0;   // whole round ready once every drink is checked
      Q.setRoundStat.run(allUp ? "up" : "working", id);
      broadcast();
      return sendJSON(res, 200, { ...Q.getRound.get(id), tickets: Q.roundTickets.all(id) });
    }

    if ((m = pathname.match(/^\/api\/rounds\/(\d+)$/)) && method === "DELETE") {
      const id = Number(m[1]);
      // Remove = discard the round and its drinks entirely (not back to the rail).
      db.transaction(() => { Q.deleteRoundTickets.run(id); Q.deleteRound.run(id); })();
      broadcast();
      return sendJSON(res, 200, { ok: true });
    }

    // 86 a whole round with a reason — records a cancellation per ticket (so every
    // guest in it is notified), then discards the round.
    if ((m = pathname.match(/^\/api\/rounds\/(\d+)\/cancel$/)) && method === "POST") {
      const id = Number(m[1]);
      const b = await readBody(req);
      const reason = str(b.reason, 120) || null;
      const tix = Q.roundTickets.all(id);
      db.transaction(() => {
        for (const t of tix) { Q.insertCancellation.run(t.id, t.drink, t.guest_name || null, reason); }
        Q.deleteRoundTickets.run(id);
        Q.deleteRound.run(id);
      })();
      broadcast();
      return sendJSON(res, 200, { ok: true });
    }

    if (pathname === "/api/theme" && method === "POST") {
      const b = await readBody(req);
      if (String(b.code) !== CODE) return sendJSON(res, 403, { error: "bad code" });
      const valid = ["auto", "herbarium", "halloween", "christmas", "birthday"];
      const t = String(b.theme || "");
      if (!valid.includes(t)) return sendJSON(res, 400, { error: "bad theme" });
      Q.setSetting.run("theme", t);
      broadcast();
      return sendJSON(res, 200, { ok: true });
    }

    if (pathname === "/api/86" && method === "POST") {
      const b = await readBody(req);
      if (String(b.code) !== CODE) return sendJSON(res, 403, { error: "bad code" });
      const ing = str(b.ingredient, 80);
      if (!ing) return sendJSON(res, 400, { error: "ingredient required" });
      if (b.out) Q.set86.run(ing); else Q.unset86.run(ing);
      broadcast();
      return sendJSON(res, 200, { ok: true });
    }

    if (pathname === "/api/86/restock" && method === "POST") {
      const b = await readBody(req);
      if (String(b.code) !== CODE) return sendJSON(res, 403, { error: "bad code" });
      Q.clear86.run();
      broadcast();
      return sendJSON(res, 200, { ok: true });
    }

    if (pathname === "/api/clear-served" && method === "POST") {
      db.transaction(() => { Q.clearServedTix.run(); Q.clearServedRnd.run(); })();
      broadcast();
      return sendJSON(res, 200, { ok: true });
    }

    if (pathname === "/api/reset" && method === "POST") {
      db.transaction(() => { Q.clearTickets.run(); Q.clearRounds.run(); })();
      broadcast();
      return sendJSON(res, 200, { ok: true });
    }

    // ---- The Ledger (persistent drink stats) ----
    if (pathname === "/api/history" && method === "GET") {
      const ns = Q.getSetting.get("night_start");
      const manual = (ns && ns.value) || "";
      const auto = lastResetUTC(new Date());                       // auto-reset at 4 AM ET
      const nightStart = (manual && manual > auto) ? manual : auto; // a later manual reset wins
      return sendJSON(res, 200, { rows: Q.historyRows.all(), nightStart, now: Q.nowStr.get().t });
    }
    if (pathname === "/api/history/new-night" && method === "POST") {
      const b = await readBody(req);
      if (String(b.code) !== CODE) return sendJSON(res, 403, { error: "bad code" });
      Q.setSetting.run("night_start", Q.nowStr.get().t);
      // Reactions are kept — the night stamp drops old ones out of "tonight" on its own,
      // so drinks keep a lifetime tally and guests can re-rate the next night.
      Q.clearCancellations.run();   // fresh favorite race for the new night
      resetParlour();               // games are ephemeral — clear the room
      broadcast();
      return sendJSON(res, 200, { ok: true, nightStart: Q.nowStr.get().t });
    }
    if (pathname === "/api/history/clear" && method === "POST") {
      const b = await readBody(req);
      if (String(b.code) !== CODE) return sendJSON(res, 403, { error: "bad code" });
      Q.clearHistory.run();
      Q.clearWall.run();
      Q.clearReactions.run();
      Q.clearCancellations.run();
      resetParlour();
      Q.setSetting.run("night_start", Q.nowStr.get().t);
      broadcast();
      return sendJSON(res, 200, { ok: true });
    }

    // ---- The Wall (party notes) ----
    if (pathname === "/api/wall" && method === "GET") {
      const ns = Q.getSetting.get("night_start");
      const manual = (ns && ns.value) || "";
      const auto = lastResetUTC(new Date());
      return sendJSON(res, 200, { posts: Q.wallRows.all(), nightStart: (manual && manual > auto) ? manual : auto });
    }
    if (pathname === "/api/wall" && method === "POST") {
      const b = await readBody(req);
      const text = str(b.text, 180);
      if (!text) return sendJSON(res, 400, { error: "text required" });
      Q.insertWall.run(text, str(b.name, 60));
      broadcast();
      return sendJSON(res, 201, { ok: true });
    }
    if (pathname === "/api/wall/remove" && method === "POST") {
      const b = await readBody(req);
      if (String(b.code) !== CODE) return sendJSON(res, 403, { error: "bad code" });
      Q.deleteWall.run(Number(b.id));
      broadcast();
      return sendJSON(res, 200, { ok: true });
    }

    // ---- Reactions ----
    if (pathname === "/api/reactions" && method === "POST") {
      const b = await readBody(req);
      const cid = str(b.cid, 40), drink = str(b.drink, 80), emoji = str(b.emoji, 16);
      if (!cid || !drink || !emoji) return sendJSON(res, 400, { error: "cid, drink, emoji required" });
      const ns = currentNightStart();
      if (b.on) Q.setReaction.run(cid, drink, emoji, ns); else Q.clearReaction.run(cid, drink, emoji, ns);
      broadcast();
      return sendJSON(res, 200, { ok: true });
    }

    // ---- The Parlour ----
    if (pathname === "/api/parlour/join" && method === "POST") {
      const b = await readBody(req);
      const cid = str(b.cid, 40);
      if (!cid) return sendJSON(res, 400, { error: "cid required" });
      Q.parlourUpsertPlayer.run(cid, str(b.name, 60));
      broadcast();
      return sendJSON(res, 200, { ok: true });
    }
    if (pathname === "/api/parlour/settings" && method === "POST") {
      const b = await readBody(req);
      if (String(b.code) !== CODE) return sendJSON(res, 403, { error: "bad code" });
      const p = getParlour();
      if (b.spicy != null) p.spicy = !!b.spicy;
      if (b.advance != null) p.advance = b.advance === "anyone" ? "anyone" : "host";
      if (b.showWho != null) p.showWho = !!b.showWho;
      if (b.scoring != null) p.scoring = !!b.scoring;
      saveParlour(p); broadcast();
      return sendJSON(res, 200, { ok: true });
    }
    if (pathname === "/api/parlour/open" && method === "POST") {
      const b = await readBody(req);
      if (String(b.code) !== CODE) return sendJSON(res, 403, { error: "bad code" });
      const game = str(b.game, 20);
      if (!PARLOUR_PROMPTS[game]) return sendJSON(res, 400, { error: "unknown game" });
      Q.parlourClearAnswers.run();
      const p = getParlour();
      p.game = game; p.phase = "lobby"; p.round = 0; p.prompt = ""; p.dealt = []; p.startedAt = Q.nowStr.get().t;
      saveParlour(p); broadcast();
      return sendJSON(res, 200, { ok: true });
    }
    // deal = start the next round (also used for "next"); governed by the advance toggle
    if (pathname === "/api/parlour/deal" && method === "POST") {
      const b = await readBody(req);
      if (!canAdvance(b)) return sendJSON(res, 403, { error: "bad code" });
      const p = getParlour();
      if (!p.game) return sendJSON(res, 400, { error: "no game" });
      const pr = dealParlourPrompt(p);
      if (!pr) return sendJSON(res, 400, { error: "out of prompts" });
      Q.parlourClearAnswers.run();
      p.prompt = pr; p.round = (p.round || 0) + 1; p.phase = "answer";
      saveParlour(p); broadcast();
      return sendJSON(res, 200, { ok: true });
    }
    if (pathname === "/api/parlour/answer" && method === "POST") {
      const b = await readBody(req);
      const cid = str(b.cid, 40), value = str(b.value, 20);
      if (!cid || !value) return sendJSON(res, 400, { error: "cid, value required" });
      const p = getParlour();
      if (p.phase !== "answer") return sendJSON(res, 409, { error: "not accepting answers" });
      Q.parlourUpsertPlayer.run(cid, str(b.name, 60));
      Q.parlourSetAnswer.run(p.round, cid, value);
      broadcast();
      return sendJSON(res, 200, { ok: true });
    }
    if (pathname === "/api/parlour/reveal" && method === "POST") {
      const b = await readBody(req);
      if (!canAdvance(b)) return sendJSON(res, 403, { error: "bad code" });
      const p = getParlour();
      if (!p.game || p.phase !== "answer") return sendJSON(res, 409, { error: "nothing to reveal" });
      p.phase = "reveal"; saveParlour(p); broadcast();
      return sendJSON(res, 200, { ok: true });
    }
    if (pathname === "/api/parlour/end" && method === "POST") {
      const b = await readBody(req);
      if (String(b.code) !== CODE) return sendJSON(res, 403, { error: "bad code" });
      const p = getParlour();
      p.game = null; p.phase = "ended"; p.prompt = ""; p.round = 0; p.dealt = [];
      Q.parlourClearAnswers.run();
      saveParlour(p); broadcast();
      return sendJSON(res, 200, { ok: true });
    }
    // anyone can drop a prompt into the pool — no approval (it's friends)
    if (pathname === "/api/parlour/prompt" && method === "POST") {
      const b = await readBody(req);
      const game = str(b.game, 20) || "confession";
      const text = str(b.text, 160);
      if (!PARLOUR_PROMPTS[game]) return sendJSON(res, 400, { error: "unknown game" });
      if (!text) return sendJSON(res, 400, { error: "text required" });
      Q.parlourAddPrompt.run(game, text, b.spicy ? 1 : 0);
      broadcast();
      return sendJSON(res, 201, { ok: true });
    }

    return sendJSON(res, 404, { error: "not found" });
  } catch (e) {
    return sendJSON(res, 500, { error: String((e && e.message) || e) });
  }
});

server.listen(PORT, HOST, () => console.log(`The Hollow API → http://${HOST}:${PORT}  (db: ${DB_PATH})`));
