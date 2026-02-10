require("dotenv").config();
const crypto = require("crypto");
const http = require("http");
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const webpush = require("web-push");
const { Server } = require("socket.io");
const { run, get, all } = require("./db");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.FRONTEND_URL || "http://localhost:5173" },
});

const PORT = process.env.PORT || 4000;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const SESSION_TTL_DAYS = parseInt(process.env.SESSION_TTL_DAYS || "7", 10);
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-secret-change-me";
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(express.json());
app.use(cookieParser(SESSION_SECRET));
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

function nowIso() {
  return new Date().toISOString();
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto
    .pbkdf2Sync(password, salt, 100000, 64, "sha256")
    .toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const verify = crypto
    .pbkdf2Sync(password, salt, 100000, 64, "sha256")
    .toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(verify));
}

const POSITIVE = [
  "great",
  "good",
  "awesome",
  "love",
  "excellent",
  "happy",
  "win",
  "progress",
  "success",
  "improved",
];
const NEGATIVE = [
  "bad",
  "blocked",
  "issue",
  "bug",
  "delay",
  "problem",
  "sad",
  "fail",
  "risk",
  "stuck",
];

function detectMood(text) {
  const t = text.toLowerCase();
  let score = 0;
  for (const w of POSITIVE) if (t.includes(w)) score += 1;
  for (const w of NEGATIVE) if (t.includes(w)) score -= 1;
  if (score >= 2) return "positive";
  if (score <= -2) return "negative";
  return "neutral";
}

async function getUserFromSession(req) {
  const sessionId = req.cookies.session_id;
  if (!sessionId) return null;

  const session = await get("SELECT * FROM sessions WHERE id = ?", [sessionId]);
  if (!session) return null;

  const expiresAt = new Date(session.expires_at);
  if (expiresAt <= new Date()) {
    await run("DELETE FROM sessions WHERE id = ?", [sessionId]);
    return null;
  }

  const user = await get(
    "SELECT id, email, role, display_name FROM users WHERE id = ?",
    [session.user_id]
  );
  return user || null;
}

function requireAuth(handler) {
  return async (req, res) => {
    try {
      const user = await getUserFromSession(req);
      if (!user) return res.status(401).json({ error: "unauthorized" });
      req.user = user;
      return handler(req, res);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "server_error" });
    }
  };
}

async function ensureFirstUserAdmin() {
  const row = await get("SELECT COUNT(*) as count FROM users");
  return row && row.count === 0;
}

async function sendPushToAll(payload) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  const subs = await all("SELECT * FROM notification_subs");
  for (const sub of subs) {
    const subscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    };
    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload));
    } catch (err) {
      await run("DELETE FROM notification_subs WHERE id = ?", [sub.id]);
    }
  }
}

async function buildUpdatePayload(updateId, userId) {
  const update = await get(
    `SELECT updates.id, title, status, body, mood, updates.created_at, updates.updated_at,
            users.email as author_email, users.display_name as author_name
     FROM updates
     JOIN users ON users.id = updates.author_id
     WHERE updates.id = ?`,
    [updateId]
  );
  if (!update) return null;

  const reactions = await all(
    "SELECT reaction, COUNT(*) as count FROM reactions WHERE update_id = ? GROUP BY reaction",
    [updateId]
  );

  const poll = await get("SELECT * FROM polls WHERE update_id = ?", [updateId]);
  let pollPayload = null;
  if (poll) {
    const options = await all(
      "SELECT id, option_text FROM poll_options WHERE poll_id = ?",
      [poll.id]
    );
    const votes = await all(
      "SELECT option_id, COUNT(*) as count FROM poll_votes WHERE poll_id = ? GROUP BY option_id",
      [poll.id]
    );
    const myVote = userId
      ? await get(
          "SELECT option_id FROM poll_votes WHERE poll_id = ? AND user_id = ?",
          [poll.id, userId]
        )
      : null;
    pollPayload = {
      id: poll.id,
      question: poll.question,
      options: options.map((o) => ({
        id: o.id,
        text: o.option_text,
        votes: votes.find((v) => v.option_id === o.id)?.count || 0,
      })),
      myVote: myVote ? myVote.option_id : null,
    };
  }

  return {
    ...update,
    author_name: update.author_name || update.author_email,
    reactions,
    poll: pollPayload,
  };
}

app.get("/", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const displayName = String(req.body.displayName || "").trim();
    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "invalid_email" });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "weak_password" });
    }

    let user = await get("SELECT * FROM users WHERE email = ?", [email]);
    if (!user) {
      const first = await ensureFirstUserAdmin();
      const role = first ? "admin" : "member";
      const created = await run(
        "INSERT INTO users (email, role, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)",
        [email, role, hashPassword(password), displayName, nowIso()]
      );
      user = await get("SELECT * FROM users WHERE id = ?", [created.id]);
    } else {
      if (user.password_hash) {
        return res.status(400).json({ error: "user_exists" });
      }
      await run(
        "UPDATE users SET password_hash = ?, display_name = ? WHERE id = ?",
        [hashPassword(password), displayName, user.id]
      );
      user = await get("SELECT * FROM users WHERE id = ?", [user.id]);
    }

    const sessionId = crypto.randomBytes(24).toString("hex");
    const sessionExpires = addDays(new Date(), SESSION_TTL_DAYS).toISOString();
    await run(
      "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
      [sessionId, user.id, sessionExpires, nowIso()]
    );

    res.cookie("session_id", sessionId, {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: SESSION_TTL_DAYS * 86400000,
    });

    res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        display_name: user.display_name,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "invalid_email" });
    }
    const user = await get("SELECT * FROM users WHERE email = ?", [email]);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(400).json({ error: "invalid_credentials" });
    }

    const sessionId = crypto.randomBytes(24).toString("hex");
    const sessionExpires = addDays(new Date(), SESSION_TTL_DAYS).toISOString();
    await run(
      "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
      [sessionId, user.id, sessionExpires, nowIso()]
    );

    res.cookie("session_id", sessionId, {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: SESSION_TTL_DAYS * 86400000,
    });

    res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        display_name: user.display_name,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

app.post("/api/auth/logout", requireAuth(async (req, res) => {
  const sessionId = req.cookies.session_id;
  if (sessionId) {
    await run("DELETE FROM sessions WHERE id = ?", [sessionId]);
  }
  res.clearCookie("session_id");
  res.json({ ok: true });
}));

app.get("/api/me", requireAuth(async (req, res) => {
  res.json({ user: req.user });
}));

app.get("/api/updates", requireAuth(async (req, res) => {
  const mood = String(req.query.mood || "").trim().toLowerCase();
  const whereMood = ["positive", "neutral", "negative"].includes(mood)
    ? "WHERE updates.mood = ?"
    : "";
  const params = whereMood ? [mood] : [];

  const rows = await all(
    `SELECT updates.id
     FROM updates
     ${whereMood}
     ORDER BY updates.created_at DESC`,
    params
  );

  const updates = [];
  for (const row of rows) {
    const payload = await buildUpdatePayload(row.id, req.user.id);
    if (payload) updates.push(payload);
  }

  res.json({ updates });
}));

app.post("/api/updates", requireAuth(async (req, res) => {
  const title = String(req.body.title || "Status update").trim();
  const body = String(req.body.body || req.body.text || "").trim();
  const status = String(req.body.category || "Update").trim();
  const poll = req.body.poll || null;

  if (!body) {
    return res.status(400).json({ error: "missing_fields" });
  }

  const mood = detectMood(`${title} ${body}`);
  const now = nowIso();
  const result = await run(
    "INSERT INTO updates (title, status, body, mood, author_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [title, status, body, mood, req.user.id, now, now]
  );

  if (poll && poll.question && Array.isArray(poll.options) && poll.options.length >= 2) {
    const pollInsert = await run(
      "INSERT INTO polls (update_id, question, created_at) VALUES (?, ?, ?)",
      [result.id, String(poll.question).trim(), nowIso()]
    );
    for (const opt of poll.options) {
      const text = String(opt).trim();
      if (text) {
        await run(
          "INSERT INTO poll_options (poll_id, option_text) VALUES (?, ?)",
          [pollInsert.id, text]
        );
      }
    }
  }

  const payload = await buildUpdatePayload(result.id, req.user.id);
  io.emit("update:new", payload);
  await sendPushToAll({
    title: "New status update",
    body: payload ? payload.title : "New update posted",
  });

  res.json({ update: payload });
}));

app.post("/api/updates/:id/reactions", requireAuth(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const reaction = String(req.body.reaction || "").trim().toLowerCase();
  if (!reaction) return res.status(400).json({ error: "missing_reaction" });

  await run(
    "INSERT OR IGNORE INTO reactions (update_id, user_id, reaction, created_at) VALUES (?, ?, ?, ?)",
    [id, req.user.id, reaction, nowIso()]
  );

  const payload = await buildUpdatePayload(id, req.user.id);
  io.emit("update:reaction", payload);
  res.json({ update: payload });
}));

app.post("/api/polls/:id/vote", requireAuth(async (req, res) => {
  const pollId = parseInt(req.params.id, 10);
  const optionId = parseInt(req.body.optionId, 10);
  if (!optionId) return res.status(400).json({ error: "missing_option" });

  await run("DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?", [
    pollId,
    req.user.id,
  ]);
  await run(
    "INSERT INTO poll_votes (poll_id, option_id, user_id, created_at) VALUES (?, ?, ?, ?)",
    [pollId, optionId, req.user.id, nowIso()]
  );

  const poll = await get("SELECT update_id FROM polls WHERE id = ?", [pollId]);
  const payload = poll ? await buildUpdatePayload(poll.update_id, req.user.id) : null;
  io.emit("poll:vote", payload);

  await sendPushToAll({
    title: "Poll updated",
    body: "A poll received new votes.",
  });

  res.json({ update: payload });
}));

app.get("/api/analytics/active-users", requireAuth(async (req, res) => {
  const rows = await all(
    `SELECT users.id, users.email, users.display_name, COUNT(*) as count
     FROM updates
     JOIN users ON users.id = updates.author_id
     GROUP BY users.id
     ORDER BY count DESC
     LIMIT 5`
  );
  res.json({
    topUsers: rows.map((r) => ({
      id: r.id,
      name: r.display_name || r.email,
      count: r.count,
    })),
  });
}));

app.get("/api/analytics/mood-trends", requireAuth(async (req, res) => {
  const rows = await all(
    `SELECT substr(created_at, 1, 10) as day, mood, COUNT(*) as count
     FROM updates
     GROUP BY day, mood
     ORDER BY day ASC`
  );
  res.json({ trends: rows });
}));

app.get("/api/prefs", requireAuth(async (req, res) => {
  const row = await get("SELECT * FROM user_prefs WHERE user_id = ?", [req.user.id]);
  res.json({ prefs: row || null });
}));

app.put("/api/prefs", requireAuth(async (req, res) => {
  const layoutJson = JSON.stringify(req.body.layout || {});
  const favoriteMoods = JSON.stringify(req.body.favoriteMoods || []);
  const now = nowIso();
  await run(
    "INSERT INTO user_prefs (user_id, layout_json, favorite_moods, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(user_id) DO UPDATE SET layout_json = excluded.layout_json, favorite_moods = excluded.favorite_moods, updated_at = excluded.updated_at",
    [req.user.id, layoutJson, favoriteMoods, now]
  );
  res.json({ ok: true });
}));

app.get("/api/notifications/public-key", requireAuth(async (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY || null });
}));

app.post("/api/notifications/subscribe", requireAuth(async (req, res) => {
  const sub = req.body || {};
  if (!sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return res.status(400).json({ error: "invalid_subscription" });
  }
  await run(
    "INSERT OR IGNORE INTO notification_subs (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)",
    [req.user.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth, nowIso()]
  );
  res.json({ ok: true });
}));

app.post("/api/notifications/unsubscribe", requireAuth(async (req, res) => {
  const endpoint = String(req.body.endpoint || "");
  if (!endpoint) return res.status(400).json({ error: "invalid_endpoint" });
  await run("DELETE FROM notification_subs WHERE endpoint = ?", [endpoint]);
  res.json({ ok: true });
}));

io.on("connection", (socket) => {
  socket.on("disconnect", () => {});
});

server.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
});
