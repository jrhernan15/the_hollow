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

const Q = {
  insertTicket:  db.prepare("INSERT INTO tickets (drink, guest_name, notes, qty) VALUES (?,?,?,?)"),
  getTicket:     db.prepare("SELECT * FROM tickets WHERE id = ?"),
  railTickets:   db.prepare("SELECT * FROM tickets WHERE status = 'rail' ORDER BY created_at, id"),
  deleteTicket:  db.prepare("DELETE FROM tickets WHERE id = ?"),
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
  insertHistory: db.prepare("INSERT INTO history (drink, qty, guest, round_id) VALUES (?,?,?,?)"),
  historyRows:   db.prepare("SELECT drink, qty, guest, round_id, created_at FROM history ORDER BY created_at, id"),
  historyHasRoundDrink:    db.prepare("SELECT 1 FROM history WHERE round_id = ? AND drink = ? LIMIT 1"),
  deleteHistoryRoundDrink: db.prepare("DELETE FROM history WHERE round_id = ? AND drink = ?"),
  deleteHistoryRound:      db.prepare("DELETE FROM history WHERE round_id = ?"),
  clearHistory:  db.prepare("DELETE FROM history"),
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

function getState() {
  const rail = Q.railTickets.all();
  const rounds = Q.allRounds.all().map((r) => ({ ...r, tickets: Q.roundTickets.all(r.id) }));
  const themeRow = Q.getSetting.get("theme");
  return { rail, rounds, eightySix: Q.all86.all().map((r) => r.ingredient), theme: (themeRow && themeRow.value) || "auto" };
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
      Q.deleteTicket.run(Number(m[1]));
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
      return sendJSON(res, 200, { rows: Q.historyRows.all(), nightStart: (ns && ns.value) || null, now: Q.nowStr.get().t });
    }
    if (pathname === "/api/history/new-night" && method === "POST") {
      const b = await readBody(req);
      if (String(b.code) !== CODE) return sendJSON(res, 403, { error: "bad code" });
      Q.setSetting.run("night_start", Q.nowStr.get().t);
      return sendJSON(res, 200, { ok: true, nightStart: Q.nowStr.get().t });
    }
    if (pathname === "/api/history/clear" && method === "POST") {
      const b = await readBody(req);
      if (String(b.code) !== CODE) return sendJSON(res, 403, { error: "bad code" });
      Q.clearHistory.run();
      Q.setSetting.run("night_start", Q.nowStr.get().t);
      return sendJSON(res, 200, { ok: true });
    }

    return sendJSON(res, 404, { error: "not found" });
  } catch (e) {
    return sendJSON(res, 500, { error: String((e && e.message) || e) });
  }
});

server.listen(PORT, HOST, () => console.log(`The Hollow API → http://${HOST}:${PORT}  (db: ${DB_PATH})`));
