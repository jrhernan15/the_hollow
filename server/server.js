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
  round INTEGER NOT NULL, cid TEXT NOT NULL, value TEXT NOT NULL, answer_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (round, cid)
);`);
{ const _pa = db.prepare("PRAGMA table_info(parlour_answers)").all(); if (!_pa.some((c) => c.name === "answer_id")) db.exec("ALTER TABLE parlour_answers ADD COLUMN answer_id INTEGER"); }
db.exec(`CREATE TABLE IF NOT EXISTS parlour_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, game TEXT NOT NULL, text TEXT NOT NULL,
  spicy INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);
// A dropped-in prompt starts life 'pending' (tonight only, dealt with priority so the room
// can vote on it). If the room keeps it, it becomes 'saved' with a tier and joins the pool
// permanently. Add the columns if we're upgrading an older DB.
{ const cols = db.prepare("PRAGMA table_info(parlour_prompts)").all().map((c) => c.name);
  if (!cols.includes("status")) db.exec("ALTER TABLE parlour_prompts ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");
  if (!cols.includes("tier"))   db.exec("ALTER TABLE parlour_prompts ADD COLUMN tier TEXT");
  if (!cols.includes("night"))  db.exec("ALTER TABLE parlour_prompts ADD COLUMN night TEXT");
  if (!cols.includes("author")) db.exec("ALTER TABLE parlour_prompts ADD COLUMN author TEXT"); }
// The room's keep/skip vote on a pending prompt, one per device per round.
db.exec(`CREATE TABLE IF NOT EXISTS parlour_keepvotes (
  round INTEGER NOT NULL, cid TEXT NOT NULL, vote TEXT NOT NULL,
  PRIMARY KEY (round, cid)
);`);
// The Usual: guesses (who each player thinks wrote each shuffled answer) + cumulative scores.
db.exec(`CREATE TABLE IF NOT EXISTS parlour_guesses (
  round INTEGER NOT NULL, guesser_cid TEXT NOT NULL, answer_id INTEGER NOT NULL, guess_cid TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (round, guesser_cid, answer_id)
);`);
db.exec(`CREATE TABLE IF NOT EXISTS parlour_scores ( cid TEXT PRIMARY KEY, points INTEGER NOT NULL DEFAULT 0 );`);

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
  parlourActivePlayers: db.prepare("SELECT cid, name FROM parlour_players WHERE last_seen >= datetime('now','-12 minutes') ORDER BY joined_at, cid"),
  parlourRemovePlayer: db.prepare("DELETE FROM parlour_players WHERE cid = ?"),
  parlourClearPlayers: db.prepare("DELETE FROM parlour_players"),
  parlourSetAnswer:    db.prepare("INSERT INTO parlour_answers (round, cid, value) VALUES (?, ?, ?) ON CONFLICT(round, cid) DO UPDATE SET value = excluded.value, created_at = datetime('now')"),
  parlourRoundSplit:   db.prepare("SELECT value, COUNT(*) AS n FROM parlour_answers WHERE round = ? GROUP BY value"),
  parlourRoundVotes:   db.prepare("SELECT a.cid AS cid, a.value AS value, pl.name AS name FROM parlour_answers a LEFT JOIN parlour_players pl ON pl.cid = a.cid WHERE a.round = ?"),
  parlourRoundCount:   db.prepare("SELECT COUNT(*) AS n FROM parlour_answers WHERE round = ?"),
  parlourClearAnswers: db.prepare("DELETE FROM parlour_answers"),
  parlourAddPrompt:    db.prepare("INSERT INTO parlour_prompts (game, text, spicy, status, night, author) VALUES (?, ?, ?, 'pending', ?, ?)"),
  parlourPendingList:  db.prepare("SELECT id, text FROM parlour_prompts WHERE game = ? AND status = 'pending' ORDER BY id"),
  parlourSavedList:    db.prepare("SELECT text, tier FROM parlour_prompts WHERE game = ? AND status = 'saved'"),
  parlourPromptById:   db.prepare("SELECT id, game, text, status FROM parlour_prompts WHERE id = ?"),
  parlourSavePrompt:   db.prepare("UPDATE parlour_prompts SET status = 'saved', tier = ?, spicy = ? WHERE id = ?"),
  parlourDiscardPrompt: db.prepare("DELETE FROM parlour_prompts WHERE id = ?"),
  parlourClearPending: db.prepare("DELETE FROM parlour_prompts WHERE status = 'pending'"),
  parlourClearPrompts: db.prepare("DELETE FROM parlour_prompts"),
  parlourPendingCount: db.prepare("SELECT COUNT(*) AS n FROM parlour_prompts WHERE status = 'pending'"),
  parlourSavedCount:   db.prepare("SELECT COUNT(*) AS n FROM parlour_prompts WHERE status = 'saved'"),
  parlourKeepVote:     db.prepare("INSERT INTO parlour_keepvotes (round, cid, vote) VALUES (?, ?, ?) ON CONFLICT(round, cid) DO UPDATE SET vote = excluded.vote"),
  parlourKeepTally:    db.prepare("SELECT vote, COUNT(*) AS n FROM parlour_keepvotes WHERE round = ? GROUP BY vote"),
  parlourClearKeepVotes: db.prepare("DELETE FROM parlour_keepvotes"),
  // The Usual
  parlourRoundAnswers: db.prepare("SELECT cid, value, answer_id FROM parlour_answers WHERE round = ? ORDER BY answer_id"),
  parlourSetAnswerId:  db.prepare("UPDATE parlour_answers SET answer_id = ? WHERE round = ? AND cid = ?"),
  parlourInsertGuess:  db.prepare("INSERT INTO parlour_guesses (round, guesser_cid, answer_id, guess_cid) VALUES (?, ?, ?, ?) ON CONFLICT(round, guesser_cid, answer_id) DO UPDATE SET guess_cid = excluded.guess_cid"),
  parlourRoundGuesses: db.prepare("SELECT guesser_cid, answer_id, guess_cid FROM parlour_guesses WHERE round = ?"),
  parlourRemoveAnswer: db.prepare("DELETE FROM parlour_answers WHERE round = ? AND cid = ?"),
  parlourRemoveGuesses: db.prepare("DELETE FROM parlour_guesses WHERE round = ? AND guesser_cid = ?"),
  parlourClearGuesses: db.prepare("DELETE FROM parlour_guesses"),
  parlourAddScore:     db.prepare("INSERT INTO parlour_scores (cid, points) VALUES (?, ?) ON CONFLICT(cid) DO UPDATE SET points = points + excluded.points"),
  parlourScores:       db.prepare("SELECT s.cid AS cid, s.points AS points, pl.name AS name FROM parlour_scores s LEFT JOIN parlour_players pl ON pl.cid = s.cid ORDER BY s.points DESC, name"),
  parlourClearScores:  db.prepare("DELETE FROM parlour_scores"),
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
// Bundled game prompts live in server/parlour-prompts.json (categorized). Fill-in "blank"
// cards are labeled by bucket ("food", "animal", ...) and enter the pools as objects; the
// "fill" phase collects the word(s) from a player before the round is played ("The Blanks").
// The small fallback keeps the games working if the file is ever missing.
const PARLOUR_FALLBACK = {
  confession: { tame: ["Never have I ever fallen asleep at a party."], spicy: ["Never have I ever texted an ex after midnight."], raunchy: ["Never have I ever sent a spicy text to the wrong chat."] },
  fork: { tame: ["Coast | Mountains"], spicy: ["Truth | Dare"], raunchy: ["Skinny dip | Streak"] },
  usual: { tame: ["Describe tonight as a cocktail."], spicy: ["What's your biggest ick?"], raunchy: ["What's your worst-kept secret about your love life?"] },
};
const PARLOUR_TIERS = ["tame", "spicy", "raunchy"];
const PARLOUR_GAMES = ["confession", "fork", "usual"];
// Fallback words for the fill phase — used when the host taps "fill it for them" or the room
// is empty. Entries run through the same injector as player words, so they may carry their
// own determiner ("the dishes") or be multi-word phrases ("a load of laundry").
const FILL_FALLBACK = {
  people: ["my ex", "your landlord", "a mall Santa", "the neighbors", "a retired clown", "my dentist", "a nosy coworker", "your mother-in-law", "the mailman", "a wedding DJ", "my old gym teacher", "a fortune teller", "the babysitter", "a conspiracy theorist", "my barber", "a mime", "the HOA president", "a substitute teacher", "an off-duty cop", "a street magician"],
  object: ["traffic cone", "lava lamp", "garden gnome", "waffle iron", "fanny pack", "inflatable flamingo", "ouija board", "unicycle", "bean bag chair", "accordion", "disco ball", "foam sword", "tax form", "karaoke machine", "snow globe", "extension cord", "novelty mug", "leaf blower", "air fryer", "umbrella"],
  food: ["lasagna", "rotisserie chicken", "family-size bag of chips", "birthday cake", "burrito", "jar of pickles", "charcuterie board", "sleeve of cookies", "pot of mac and cheese", "watermelon", "meatloaf", "onion", "block of cheese", "sheet cake", "tub of frosting", "casserole", "loaf of garlic bread", "pumpkin pie", "bucket of fried chicken", "quesadilla"],
  place: ["Waffle House", "the DMV", "a haunted house", "the airport", "a Renaissance fair", "the gym parking lot", "a cruise ship", "the break room", "a petting zoo", "IKEA", "a karaoke bar", "the laundromat", "a corn maze", "the dentist's office", "a bowling alley", "Costco", "a rooftop bar", "the county fair", "a rest stop", "grandma's house"],
  activity: ["hot yoga", "karaoke", "speed dating", "axe throwing", "a road trip", "line dancing", "trivia night", "a silent retreat", "couples therapy", "jury duty", "a spin class", "birdwatching", "a garage sale", "improv class", "a pub crawl", "goat yoga", "a book club", "paintball", "a magic show", "water aerobics"],
  drink: ["espresso martini", "warm gas station coffee", "protein shake", "boxed wine", "energy drink", "kombucha", "pickle juice", "hot toddy", "gallon of sweet tea", "smoothie", "flat soda", "oat milk latte", "root beer float", "green juice", "double IPA", "juice box", "mimosa", "glass of tap water", "milkshake", "iced coffee"],
  animal: ["raccoon", "emu", "possum", "alpaca", "ferret", "peacock", "iguana", "goose", "miniature horse", "hedgehog", "parrot", "armadillo", "hamster", "flamingo", "goat", "snapping turtle", "chihuahua", "capybara", "rooster", "seagull"],
  chore: ["the dishes", "a load of laundry", "vacuuming", "cleaning the gutters", "mowing the lawn", "the taxes", "scrubbing the tub", "dusting", "taking out the trash", "meal prep", "weeding", "washing the car", "ironing", "organizing the garage", "defrosting the freezer", "folding laundry", "the grocery run", "walking the dog", "cleaning the litter box", "unloading the dishwasher"],
};
// Pool entries are strings (regular cards) or objects (blank cards). Content-derived keys keep
// the persisted no-repeat memory (p.dealt) valid across restarts.
const parlourKey = (e) => typeof e === "string" ? e : (e.t || (e.a + " | " + e.b));
function loadParlourPrompts() {
  const out = { confession: { tame: [], spicy: [], raunchy: [] }, fork: { tame: [], spicy: [], raunchy: [] }, usual: { tame: [], spicy: [], raunchy: [] } };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "parlour-prompts.json"), "utf8"));
    for (const g of PARLOUR_GAMES) {
      for (const e of (raw[g] || [])) {
        if (!e) continue;
        const tier = e.cat === "raunchy" ? "raunchy" : (e.cat === "spicy" ? "spicy" : "tame");
        if (e.blank) {
          // Blank card → pool it as an object; the fill phase supplies the word(s) at deal time.
          if (g === "usual" || !FILL_FALLBACK[e.blank]) continue;   // no blanks for The Usual; unknown buckets stay out
          const sides = g === "fork" ? [e.a, e.b] : [e.t];
          if (sides.some((f) => !f || (f.match(/___/g) || []).length !== 1)) continue;   // exactly one ___ per side
          out[g][tier].push(g === "fork" ? { blank: e.blank, a: e.a, b: e.b } : { blank: e.blank, t: e.t });
          continue;
        }
        const text = g === "fork" ? ((e.a && e.b) ? (e.a + " | " + e.b) : null) : e.t;   // fork = "A | B", others use .t
        if (!text || text.includes("___")) continue;   // never deal an unfilled blank
        out[g][tier].push(text);
      }
    }
  } catch (err) { console.warn("parlour-prompts.json not loaded (" + err.message + ") \u2014 using fallback"); }
  for (const g of PARLOUR_GAMES) {
    if (!out[g].tame.length && !out[g].spicy.length && !out[g].raunchy.length) out[g] = { tame: PARLOUR_FALLBACK[g].tame.slice(), spicy: PARLOUR_FALLBACK[g].spicy.slice(), raunchy: PARLOUR_FALLBACK[g].raunchy.slice() };
  }
  return out;
}
const PARLOUR_PROMPTS = loadParlourPrompts();
// "The Spice" \u2014 host dials 0..4; each level is a blend weight over [tame, spicy, raunchy].
// Level 0 (No Spice) is pure tame; raunchy stays out until Medium; the top is spicy/raunchy only.
const SPICE_LEVELS = ["No Spice", "Mild", "Medium", "Hot", "All The Spice"];
const SPICE_WEIGHTS = [
  { tame: 100, spicy: 0,  raunchy: 0  },   // 0 No Spice
  { tame: 60,  spicy: 40, raunchy: 0  },   // 1 Mild
  { tame: 30,  spicy: 50, raunchy: 20 },   // 2 Medium
  { tame: 5,   spicy: 45, raunchy: 50 },   // 3 Hot
  { tame: 0,   spicy: 35, raunchy: 65 },   // 4 All The Spice
];
function spiceLevel(p) { const n = Math.round(Number(p && p.spice)); return (n >= 0 && n <= 4) ? n : 1; }
const PARLOUR_DEFAULT = { game: null, phase: "ended", round: 0, prompt: "", promptHeat: "tame", promptFresh: false, pendingPromptId: null, dealt: [], spice: 1, advance: "host", showWho: true, scoring: true, startedAt: "", fillTemplate: null, fillerCid: "", fillerName: "", lastFillerCid: "", filledBy: "", showFillSentence: false };
function getParlour() {
  const row = Q.getSetting.get("parlour");
  if (!row || !row.value) return { ...PARLOUR_DEFAULT };
  try {
    const stored = JSON.parse(row.value);
    if (stored.spice == null && typeof stored.spicy === "boolean") stored.spice = stored.spicy ? 2 : 0;  // migrate the old binary toggle
    const p = { ...PARLOUR_DEFAULT, ...stored };
    p.spice = spiceLevel(p);
    return p;
  } catch (e) { return { ...PARLOUR_DEFAULT }; }
}
function saveParlour(p) { Q.setSetting.run("parlour", JSON.stringify(p)); }
// A new night wipes tonight's drop-ins and votes, but keeps the room's saved keepers.
function resetParlour() { Q.parlourClearPlayers.run(); Q.parlourClearAnswers.run(); Q.parlourClearGuesses.run(); Q.parlourClearScores.run(); Q.parlourClearPending.run(); Q.parlourClearKeepVotes.run(); saveParlour({ ...PARLOUR_DEFAULT }); }
function dealParlourPrompt(p) {
  const bundled = PARLOUR_PROMPTS[p.game] || { tame: [], spicy: [], raunchy: [] };
  p.dealt = Array.isArray(p.dealt) ? p.dealt : [];
  const unused = (arr) => (arr || []).filter((t) => p.dealt.indexOf(parlourKey(t)) === -1);
  // 1) Tonight's drop-ins get priority — shown so the room can vote to keep them. No tier gating.
  const pending = Q.parlourPendingList.all(p.game);
  if (pending.length) {
    const pick = pending[0];   // oldest first, so drop-ins surface in the order added
    return { text: pick.text, heat: "fresh", fresh: true, promptId: pick.id };
  }
  // 2) Otherwise draw from the bundled pack + the room's saved keepers, weighting tier by spice level.
  const w = SPICE_WEIGHTS[spiceLevel(p)];
  const allow = { tame: w.tame > 0, spicy: w.spicy > 0, raunchy: w.raunchy > 0 };
  const pool = { tame: (bundled.tame || []).slice(), spicy: (bundled.spicy || []).slice(), raunchy: (bundled.raunchy || []).slice() };
  for (const r of Q.parlourSavedList.all(p.game)) { const t = (r.tier === "raunchy" || r.tier === "spicy") ? r.tier : "tame"; pool[t].push(r.text); }
  const pickTier = () => {
    const tiers = PARLOUR_TIERS.filter((t) => allow[t] && unused(pool[t]).length);
    if (!tiers.length) return null;
    let total = 0; for (const t of tiers) total += w[t];
    let roll = Math.random() * total;
    for (const t of tiers) { roll -= w[t]; if (roll <= 0) return t; }
    return tiers[tiers.length - 1];
  };
  let tier = pickTier();
  if (!tier) { p.dealt = []; tier = pickTier(); }   // every allowed tier exhausted → reset no-repeat memory, retry
  if (!tier) return null;
  const avail = unused(pool[tier]);
  const pick = avail[Math.floor(Math.random() * avail.length)];
  p.dealt.push(parlourKey(pick));
  if (typeof pick !== "string") return { blankCard: pick, heat: tier, fresh: false, promptId: null };   // blank card → fill phase first
  return { text: pick, heat: tier, fresh: false, promptId: null };
}
function canAdvance(body) { const p = getParlour(); return p.advance === "anyone" || String(body.code) === CODE; }
// ---- The Blanks (fill phase) ----
// lastFillerCid survives clearFill on purpose — it's the rotation memory across rounds.
function clearFill(p) { p.fillTemplate = null; p.fillerCid = ""; p.fillerName = ""; }
function cleanFillWord(w) {
  // "|" would corrupt the client's "A | B" fork split; "_" blocks smuggling a literal "___" back in.
  const s = String(w == null ? "" : w).replace(/[|_]/g, " ");
  return s.replace(/\s+/g, " ").trim().slice(0, 40).trim();
}
function injectBlank(template, word) {
  const idx = template.indexOf("___");
  if (idx === -1) return null;
  let before = template.slice(0, idx);
  const after = template.slice(idx + 3);
  // Fix the article only when it's the token immediately before the blank ("eaten an entire ___" stays untouched).
  const m = before.match(/(^|[\s("“—])([Aa]n?|[Tt]he)(\s+)$/);
  if (m) {
    if (/^(a|an|the|my|your|his|her|its|our|their|some)\s/i.test(word)) {
      before = before.slice(0, m.index + m[1].length);   // the word brings its own determiner ("a load of laundry") — drop the template's
    } else if (m[2].toLowerCase() !== "the") {
      // Vowel-letter heuristic; "an hour" / "a university" misfires are accepted at a party.
      const art = /^[aeiou]/i.test(word) ? (m[2][0] === "A" ? "An" : "an") : (m[2][0] === "A" ? "A" : "a");
      before = before.slice(0, m.index + m[1].length) + art + m[3];
    }
  }
  return before + word + after;   // slice-concat, not String.replace — a word may contain "$&"
}
function pickFiller(pivotCid, excludeCid) {
  let list = Q.parlourActivePlayers.all();   // ORDER BY joined_at, cid — deterministic rotation
  if (excludeCid) list = list.filter((x) => x.cid !== excludeCid);
  if (!list.length) return null;
  const i = list.findIndex((x) => x.cid === pivotCid);   // -1 (pivot left or aged out) wraps to list[0]
  return list[(i + 1) % list.length];
}
function applyFill(p, words, who) {
  const t = p.fillTemplate;
  if (!t) return false;
  const a = injectBlank(t.a || t.t, words[0]);
  const b = t.a ? injectBlank(t.b, words[1]) : "";
  const prompt = t.a ? ((a && b) ? (a + " | " + b) : null) : a;
  if (!prompt || prompt.includes("___")) return false;   // hard guard: a "___" never reaches the answer phase
  p.prompt = prompt; p.filledBy = who; clearFill(p); p.phase = "answer";
  return true;
}
function autoFill(p) {
  const bucket = (p.fillTemplate && p.fillTemplate.blank) || "";
  const words = FILL_FALLBACK[bucket] || ["mystery"];
  const rand = () => words[Math.floor(Math.random() * words.length)];
  return applyFill(p, (p.fillTemplate && p.fillTemplate.a) ? [rand(), rand()] : [rand()], "the house");
}
function parlourState() {
  const p = getParlour();
  const players = Q.parlourActivePlayers.all();   // only recently-seen devices count as "in the room"
  const out = { game: p.game, phase: p.phase, round: p.round || 0, prompt: p.prompt || "", heat: p.promptHeat || "tame", fresh: !!p.promptFresh, spice: spiceLevel(p), spiceLabel: SPICE_LEVELS[spiceLevel(p)], advance: p.advance || "host", showWho: !!p.showWho, scoring: !!p.scoring, filledBy: p.filledBy || "", showFillSentence: !!p.showFillSentence, added: Q.parlourPendingCount.get().n, saved: Q.parlourSavedCount.get().n, players, present: players.length };
  if (p.game && p.phase === "fill" && p.fillTemplate) {
    // The template stays server-side while blind (the default). With "filler sees the card" on,
    // the sentence rides the shared broadcast — every device technically receives it; only the
    // filler's UI renders it. Fine for a LAN party.
    const t = p.fillTemplate;
    out.fill = { fillerCid: p.fillerCid || "", fillerName: p.fillerName || "Someone", bucket: t.blank || "", blanks: t.a ? 2 : 1 };
    if (p.showFillSentence) out.fill.sentence = t.a ? (t.a + " | " + t.b) : t.t;
  }
  if (p.game && (p.phase === "answer" || p.phase === "guess" || p.phase === "reveal")) {
    out.answered = Q.parlourRoundCount.get(p.round).n;
    const atReveal = p.phase === "reveal";
    if (atReveal && p.promptFresh) {   // the room is voting whether to keep this drop-in
      let up = 0, down = 0;
      for (const r of Q.parlourKeepTally.all(p.round)) { if (r.vote === "up") up = r.n; else if (r.vote === "down") down = r.n; }
      out.keep = { up: up, down: down, majority: (up > down && up > 0) ? "up" : ((down >= up && (up + down) > 0) ? "down" : "none") };
    }
    if (p.game === "confession" && atReveal) {
      let have = 0, total = 0;
      for (const r of Q.parlourRoundSplit.all(p.round)) { total += r.n; if (r.value === "have") have = r.n; }
      out.count = { have: have, total: total };
      out.fuzzy = total < 5;   // small groups: show "a few of you", not an exact count
    }
    if (p.game === "fork") {
      // The Fork shows the split live while answering, and at reveal.
      let a = 0, b = 0, total = 0;
      for (const r of Q.parlourRoundSplit.all(p.round)) { total += r.n; if (r.value === "a") a = r.n; else if (r.value === "b") b = r.n; }
      out.split = { a: a, b: b, total: total };
      if (atReveal && p.showWho) {
        const votes = Q.parlourRoundVotes.all(p.round);
        out.namesA = votes.filter((v) => v.value === "a").map((v) => (v.name && String(v.name).trim()) || "Someone");
        out.namesB = votes.filter((v) => v.value === "b").map((v) => (v.name && String(v.name).trim()) || "Someone");
      }
    }
    if (p.game === "usual") {
      if (p.phase === "guess") {
        const ans = Q.parlourRoundAnswers.all(p.round);
        out.answers = ans.map((a) => ({ id: a.answer_id, text: a.value }));   // shuffled, authors stripped
        const N = ans.length;
        const cnt = {};
        for (const g of Q.parlourRoundGuesses.all(p.round)) cnt[g.guesser_cid] = (cnt[g.guesser_cid] || 0) + 1;
        let done = 0; for (const c of Object.keys(cnt)) if (cnt[c] >= Math.max(1, N - 1)) done++;
        out.guessDone = done; out.guessTotal = N;
      }
      if (atReveal) {
        const ans = Q.parlourRoundAnswers.all(p.round);
        const gs = Q.parlourRoundGuesses.all(p.round);
        const names = {}; for (const pl of Q.parlourPlayers.all()) names[pl.cid] = (pl.name && String(pl.name).trim()) || "Someone";
        out.reveal = ans.map((a) => {
          const forThis = gs.filter((g) => g.answer_id === a.answer_id);
          const nailed = forThis.filter((g) => g.guess_cid === a.cid).map((g) => names[g.guesser_cid] || "Someone");
          const fooled = forThis.filter((g) => g.guess_cid !== a.cid && g.guesser_cid !== a.cid).length;
          return { id: a.answer_id, text: a.value, author: names[a.cid] || "Someone", nailed: nailed, fooledCount: fooled };
        });
        if (p.scoring) out.scores = Q.parlourScores.all().map((s) => ({ name: (s.name && String(s.name).trim()) || "Someone", points: s.points }));
      }
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
    // Heartbeat — keeps a watching device "in the room" without a broadcast storm.
    if (pathname === "/api/parlour/ping" && method === "POST") {
      const b = await readBody(req);
      const cid = str(b.cid, 40);
      if (cid) Q.parlourUpsertPlayer.run(cid, str(b.name, 60));
      return sendJSON(res, 200, { ok: true });
    }
    // A player leaves the game — drop them from the roster (and their pending answer/guesses).
    if (pathname === "/api/parlour/leave" && method === "POST") {
      const b = await readBody(req);
      const cid = str(b.cid, 40);
      if (!cid) return sendJSON(res, 400, { error: "cid required" });
      const p = getParlour();
      Q.parlourRemovePlayer.run(cid);
      if (p.phase === "answer") Q.parlourRemoveAnswer.run(p.round, cid);   // not yet shuffled — safe to drop
      Q.parlourRemoveGuesses.run(p.round, cid);
      if (p.phase === "fill" && cid === p.fillerCid) {
        // The filler walked out — hand the card to the next present player, or let the house fill an empty room.
        const next = pickFiller(cid, cid);
        if (next) { p.fillerCid = next.cid; p.fillerName = (next.name && String(next.name).trim()) || "Someone"; p.lastFillerCid = next.cid; }
        else autoFill(p);
        saveParlour(p);
      }
      broadcast();
      return sendJSON(res, 200, { ok: true });
    }
    if (pathname === "/api/parlour/settings" && method === "POST") {
      const b = await readBody(req);
      if (String(b.code) !== CODE) return sendJSON(res, 403, { error: "bad code" });
      const p = getParlour();
      if (b.spice != null) p.spice = spiceLevel({ spice: b.spice });
      if (b.advance != null) p.advance = b.advance === "anyone" ? "anyone" : "host";
      if (b.showWho != null) p.showWho = !!b.showWho;
      if (b.scoring != null) p.scoring = !!b.scoring;
      if (b.showFillSentence != null) p.showFillSentence = !!b.showFillSentence;
      saveParlour(p); broadcast();
      return sendJSON(res, 200, { ok: true });
    }
    if (pathname === "/api/parlour/open" && method === "POST") {
      const b = await readBody(req);
      if (String(b.code) !== CODE) return sendJSON(res, 403, { error: "bad code" });
      const game = str(b.game, 20);
      if (!PARLOUR_PROMPTS[game]) return sendJSON(res, 400, { error: "unknown game" });
      Q.parlourClearAnswers.run(); Q.parlourClearGuesses.run(); Q.parlourClearScores.run();
      const p = getParlour();
      p.game = game; p.phase = "lobby"; p.round = 0; p.prompt = ""; p.promptHeat = "tame"; p.promptFresh = false; p.pendingPromptId = null; p.dealt = []; p.startedAt = Q.nowStr.get().t;
      clearFill(p); p.filledBy = ""; p.lastFillerCid = "";
      Q.parlourClearKeepVotes.run();
      saveParlour(p); broadcast();
      return sendJSON(res, 200, { ok: true });
    }
    // deal = start the next round (also used for "next"); governed by the advance toggle
    if (pathname === "/api/parlour/deal" && method === "POST") {
      const b = await readBody(req);
      if (!canAdvance(b)) return sendJSON(res, 403, { error: "bad code" });
      const p = getParlour();
      if (!p.game) return sendJSON(res, 400, { error: "no game" });
      // If the previous round showed a drop-in the host never saved, the room passed on it → discard.
      if (p.pendingPromptId) { Q.parlourDiscardPrompt.run(p.pendingPromptId); p.pendingPromptId = null; }
      Q.parlourClearKeepVotes.run();
      const pr = dealParlourPrompt(p);
      if (!pr) return sendJSON(res, 400, { error: "out of prompts" });
      Q.parlourClearAnswers.run(); Q.parlourClearGuesses.run();
      clearFill(p); p.filledBy = "";   // re-dealing during a fill abandons that card (it stays in p.dealt)
      p.promptHeat = pr.heat; p.promptFresh = !!pr.fresh; p.pendingPromptId = pr.promptId || null; p.round = (p.round || 0) + 1;
      if (pr.blankCard) {
        // Blank card → collect the word(s) first. The filler rotates through present players.
        p.prompt = "";
        p.fillTemplate = pr.blankCard.a ? { blank: pr.blankCard.blank, a: pr.blankCard.a, b: pr.blankCard.b } : { blank: pr.blankCard.blank, t: pr.blankCard.t };
        const filler = pickFiller(p.lastFillerCid);
        if (filler) { p.fillerCid = filler.cid; p.fillerName = (filler.name && String(filler.name).trim()) || "Someone"; p.lastFillerCid = filler.cid; p.phase = "fill"; }
        else autoFill(p);   // empty room → the house fills it and play proceeds
      } else {
        p.prompt = pr.text; p.phase = "answer";
      }
      saveParlour(p); broadcast();
      return sendJSON(res, 200, { ok: true });
    }
    // the room votes to keep (or skip) tonight's drop-in — only while its reveal is up
    if (pathname === "/api/parlour/keepvote" && method === "POST") {
      const b = await readBody(req);
      const cid = str(b.cid, 40), vote = b.vote === "up" ? "up" : "down";
      if (!cid) return sendJSON(res, 400, { error: "cid required" });
      const p = getParlour();
      if (p.phase !== "reveal" || !p.promptFresh) return sendJSON(res, 409, { error: "not voting now" });
      Q.parlourUpsertPlayer.run(cid, str(b.name, 60));
      Q.parlourKeepVote.run(p.round, cid, vote);
      broadcast();
      return sendJSON(res, 200, { ok: true });
    }
    // host saves the current drop-in to the pool permanently, picking its spice tier
    if (pathname === "/api/parlour/save-prompt" && method === "POST") {
      const b = await readBody(req);
      if (String(b.code) !== CODE) return sendJSON(res, 403, { error: "bad code" });
      const p = getParlour();
      if (!p.pendingPromptId) return sendJSON(res, 409, { error: "nothing to save" });
      const tier = (b.tier === "raunchy" || b.tier === "spicy") ? b.tier : "tame";
      Q.parlourSavePrompt.run(tier, tier === "tame" ? 0 : 1, p.pendingPromptId);
      p.pendingPromptId = null; p.promptFresh = false;
      saveParlour(p); broadcast();
      return sendJSON(res, 200, { ok: true });
    }
    // host discards the current drop-in
    if (pathname === "/api/parlour/discard-prompt" && method === "POST") {
      const b = await readBody(req);
      if (String(b.code) !== CODE) return sendJSON(res, 403, { error: "bad code" });
      const p = getParlour();
      if (p.pendingPromptId) { Q.parlourDiscardPrompt.run(p.pendingPromptId); p.pendingPromptId = null; p.promptFresh = false; saveParlour(p); }
      broadcast();
      return sendJSON(res, 200, { ok: true });
    }
    if (pathname === "/api/parlour/answer" && method === "POST") {
      const b = await readBody(req);
      const cid = str(b.cid, 40), value = str(b.value, 120);
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
      if (!p.game || (p.phase !== "answer" && p.phase !== "guess")) return sendJSON(res, 409, { error: "nothing to reveal" });
      if (p.game === "usual" && p.scoring && p.phase === "guess") {
        // tally this round's points once, on the way into reveal
        const ans = Q.parlourRoundAnswers.all(p.round);
        const authorByAns = {}; for (const a of ans) authorByAns[a.answer_id] = a.cid;
        const pts = {};
        for (const g of Q.parlourRoundGuesses.all(p.round)) {
          const author = authorByAns[g.answer_id]; if (!author || g.guesser_cid === author) continue;
          if (g.guess_cid === author) pts[g.guesser_cid] = (pts[g.guesser_cid] || 0) + 1;   // nailed it
          else pts[author] = (pts[author] || 0) + 1;                                          // author fooled them
        }
        for (const c of Object.keys(pts)) Q.parlourAddScore.run(c, pts[c]);
      }
      p.phase = "reveal"; saveParlour(p); broadcast();
      return sendJSON(res, 200, { ok: true });
    }
    // The Usual: host closes answers -> shuffle + assign shuffled ids -> guessing
    if (pathname === "/api/parlour/close" && method === "POST") {
      const b = await readBody(req);
      if (!canAdvance(b)) return sendJSON(res, 403, { error: "bad code" });
      const p = getParlour();
      if (p.game !== "usual" || p.phase !== "answer") return sendJSON(res, 409, { error: "nothing to close" });
      const rows = Q.parlourRoundAnswers.all(p.round);
      const order = rows.map((_, i) => i);
      for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = order[i]; order[i] = order[j]; order[j] = t; }
      order.forEach((ri, idx) => Q.parlourSetAnswerId.run(idx + 1, p.round, rows[ri].cid));
      p.phase = "guess"; saveParlour(p); broadcast();
      return sendJSON(res, 200, { ok: true });
    }
    if (pathname === "/api/parlour/guess" && method === "POST") {
      const b = await readBody(req);
      const cid = str(b.cid, 40), guessCid = str(b.guessCid, 40);
      const answerId = parseInt(b.answerId, 10);
      if (!cid || !guessCid || !answerId) return sendJSON(res, 400, { error: "cid, answerId, guessCid required" });
      const p = getParlour();
      if (p.game !== "usual" || p.phase !== "guess") return sendJSON(res, 409, { error: "not guessing" });
      Q.parlourInsertGuess.run(p.round, cid, answerId, guessCid);
      broadcast();
      return sendJSON(res, 200, { ok: true });
    }
    if (pathname === "/api/parlour/end" && method === "POST") {
      const b = await readBody(req);
      if (String(b.code) !== CODE) return sendJSON(res, 403, { error: "bad code" });
      const p = getParlour();
      p.game = null; p.phase = "ended"; p.prompt = ""; p.round = 0; p.dealt = []; p.promptFresh = false; p.pendingPromptId = null;
      clearFill(p); p.filledBy = ""; p.lastFillerCid = "";
      Q.parlourClearAnswers.run(); Q.parlourClearGuesses.run(); Q.parlourClearScores.run(); Q.parlourClearPlayers.run(); Q.parlourClearKeepVotes.run();
      saveParlour(p); broadcast();
      return sendJSON(res, 200, { ok: true });
    }
    // anyone can drop a prompt into the pool — no approval (it's friends). It lands 'pending':
    // shown tonight so the room can vote to keep it, then either saved for good or discarded.
    if (pathname === "/api/parlour/prompt" && method === "POST") {
      const b = await readBody(req);
      const game = str(b.game, 20) || "confession";
      const text = str(b.text, 160);
      if (!PARLOUR_PROMPTS[game]) return sendJSON(res, 400, { error: "unknown game" });
      if (!text) return sendJSON(res, 400, { error: "text required" });
      if (text.includes("___")) return sendJSON(res, 400, { error: "no blanks in drop-ins" });   // drop-ins skip the fill phase — a ___ must never reach play
      Q.parlourAddPrompt.run(game, text, 0, currentNightStart(), str(b.cid, 40));
      broadcast();
      return sendJSON(res, 201, { ok: true });
    }
    // host: clear tonight's un-voted drop-ins (saved keepers stay in the pool)
    if (pathname === "/api/parlour/clear-prompts" && method === "POST") {
      const b = await readBody(req);
      if (String(b.code) !== CODE) return sendJSON(res, 403, { error: "bad code" });
      Q.parlourClearPending.run();
      const p = getParlour();
      if (p.promptFresh) { p.promptFresh = false; p.pendingPromptId = null; saveParlour(p); }
      broadcast();
      return sendJSON(res, 200, { ok: true });
    }
    // The Blanks: the filler submits the word(s) for the current blank card
    if (pathname === "/api/parlour/fill" && method === "POST") {
      const b = await readBody(req);
      const p = getParlour();
      if (!p.game || p.phase !== "fill" || !p.fillTemplate) return sendJSON(res, 409, { error: "nothing to fill" });
      const cid = str(b.cid, 40);
      if (!cid || cid !== p.fillerCid) return sendJSON(res, 403, { error: "not your card to fill" });
      const need = p.fillTemplate.a ? 2 : 1;
      const words = (Array.isArray(b.words) ? b.words : []).slice(0, need).map(cleanFillWord);
      if (words.length !== need || words.some((w) => !w)) return sendJSON(res, 400, { error: need === 2 ? "two words required" : "a word is required" });
      if (!applyFill(p, words, p.fillerName)) return sendJSON(res, 500, { error: "fill failed" });
      saveParlour(p); broadcast();
      return sendJSON(res, 200, { ok: true });
    }
    // The Blanks host valves: pass the card to the next player, or let the house fill it
    if (pathname === "/api/parlour/fill-skip" && method === "POST") {
      const b = await readBody(req);
      if (!canAdvance(b)) return sendJSON(res, 403, { error: "bad code" });
      const p = getParlour();
      if (p.phase !== "fill" || !p.fillTemplate) return sendJSON(res, 409, { error: "nothing to skip" });
      if (b.mode === "auto") {
        autoFill(p);
      } else {
        const next = pickFiller(p.fillerCid);
        if (!next || next.cid === p.fillerCid) return sendJSON(res, 409, { error: "no one else to pass to" });
        p.fillerCid = next.cid; p.fillerName = (next.name && String(next.name).trim()) || "Someone"; p.lastFillerCid = next.cid;
      }
      saveParlour(p); broadcast();
      return sendJSON(res, 200, { ok: true });
    }

    return sendJSON(res, 404, { error: "not found" });
  } catch (e) {
    return sendJSON(res, 500, { error: String((e && e.message) || e) });
  }
});

server.listen(PORT, HOST, () => console.log(`The Hollow API → http://${HOST}:${PORT}  (db: ${DB_PATH})`));
