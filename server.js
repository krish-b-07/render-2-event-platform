require("dotenv").config();

const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");

const app = express();
const port = Number(process.env.PORT || 3000);
const dataDirectory = process.env.DATA_DIR || __dirname;
const database = new DatabaseSync(path.join(dataDirectory, "render.sqlite"));
database.exec("PRAGMA journal_mode = WAL");
database.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS colleges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS point_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    college_id INTEGER NOT NULL REFERENCES colleges(id) ON DELETE CASCADE,
    event_name TEXT NOT NULL,
    points INTEGER NOT NULL CHECK (points > 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS point_adjustments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    college_id INTEGER NOT NULL REFERENCES colleges(id) ON DELETE CASCADE,
    event_name TEXT,
    points INTEGER NOT NULL CHECK (points != 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const adminPassword = process.env.ADMIN_PASSWORD || "render-admin";
const pointAdjustmentColumns = database
  .prepare("PRAGMA table_info(point_adjustments)")
  .all();
if (!pointAdjustmentColumns.some((column) => column.name === "event_name")) {
  database.exec("ALTER TABLE point_adjustments ADD COLUMN event_name TEXT");
}

const existingAdmin = database
  .prepare("SELECT id FROM admins WHERE username = ?")
  .get("organizer");
if (!existingAdmin) {
  database
    .prepare("INSERT INTO admins (username, password_hash) VALUES (?, ?)")
    .run("organizer", bcrypt.hashSync(adminPassword, 12));
}

const seedColleges = [
  "PAPNI School of Architecture",
  "School of Planning",
  "Design Collective",
];
const insertCollege = database.prepare(
  "INSERT OR IGNORE INTO colleges (name) VALUES (?)",
);
for (const college of seedColleges) insertCollege.run(college);

app.use(express.json({ limit: "1mb" }));
app.use(
  session({
    secret:
      process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", maxAge: 8 * 60 * 60 * 1000 },
  }),
);

function requireAdmin(request, response, next) {
  if (!request.session.adminId)
    return response.status(401).json({ error: "Organizer login required." });
  next();
}

function getCollegeEventTotal(collegeId, eventName) {
  const row = database
    .prepare(
      `
      SELECT COALESCE(SUM(total_points), 0) AS total
      FROM (
        SELECT points AS total_points FROM point_entries WHERE college_id = ? AND event_name = ?
        UNION ALL
        SELECT points AS total_points FROM point_adjustments WHERE college_id = ? AND event_name = ?
      )
    `,
    )
    .get(collegeId, eventName, collegeId, eventName);

  return Number(row?.total || 0);
}

function getLeaderboard() {
  const colleges = database
    .prepare(
      `
    SELECT colleges.id, colleges.name,
      (
        COALESCE((SELECT SUM(points) FROM point_entries WHERE college_id = colleges.id), 0)
        + COALESCE((SELECT SUM(points) FROM point_adjustments WHERE college_id = colleges.id), 0)
      ) AS points
    FROM colleges
    ORDER BY points DESC, colleges.name ASC
  `,
    )
    .all();

  const eventTotals = database
    .prepare(
      `
    SELECT college_id, event_name, SUM(points) AS points
    FROM (
      SELECT college_id, event_name, points FROM point_entries
      UNION ALL
      SELECT college_id, event_name, points
      FROM point_adjustments
      WHERE event_name IS NOT NULL AND TRIM(event_name) != ''
    )
    GROUP BY college_id, event_name
    ORDER BY event_name ASC, college_id ASC
  `,
    )
    .all();

  const perCollegeEvents = new Map();
  for (const row of eventTotals) {
    if (!perCollegeEvents.has(row.college_id)) {
      perCollegeEvents.set(row.college_id, []);
    }
    perCollegeEvents.get(row.college_id).push({
      event_name: row.event_name,
      points: Number(row.points),
    });
  }

  return colleges.map((college) => ({
    ...college,
    points: Math.max(0, Number(college.points) || 0),
    event_totals: (perCollegeEvents.get(college.id) || []).map((entry) => ({
      ...entry,
      points: Math.max(0, Number(entry.points) || 0),
    })),
  }));
}

app.get("/api/public/leaderboard", (_request, response) => {
  response.json({ colleges: getLeaderboard() });
});

app.post("/api/auth/login", (request, response) => {
  const { username, password } = request.body || {};
  const admin = database
    .prepare(
      "SELECT id, username, password_hash FROM admins WHERE username = ?",
    )
    .get(username);
  if (
    !admin ||
    typeof password !== "string" ||
    !bcrypt.compareSync(password, admin.password_hash)
  ) {
    return response
      .status(401)
      .json({ error: "Invalid organizer credentials." });
  }
  request.session.adminId = admin.id;
  request.session.username = admin.username;
  response.json({ username: admin.username });
});

app.post("/api/auth/logout", (request, response) => {
  request.session.destroy(() => response.json({ ok: true }));
});

app.get("/api/auth/me", (request, response) => {
  response.json({
    authenticated: Boolean(request.session.adminId),
    username: request.session.username || null,
  });
});

app.get("/api/admin/colleges", requireAdmin, (_request, response) => {
  response.json({ colleges: getLeaderboard() });
});

app.post("/api/admin/colleges", requireAdmin, (request, response) => {
  const name = String(request.body?.name || "").trim();
  if (name.length < 2 || name.length > 120)
    return response
      .status(400)
      .json({ error: "College name must be 2 to 120 characters." });
  try {
    const result = database
      .prepare("INSERT INTO colleges (name) VALUES (?)")
      .run(name);
    response.status(201).json({ id: result.lastInsertRowid, name });
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE")
      return response
        .status(409)
        .json({ error: "That college already exists." });
    throw error;
  }
});

app.put("/api/admin/colleges/:id", requireAdmin, (request, response) => {
  const name = String(request.body?.name || "").trim();
  if (name.length < 2 || name.length > 120)
    return response
      .status(400)
      .json({ error: "College name must be 2 to 120 characters." });
  try {
    const result = database
      .prepare("UPDATE colleges SET name = ? WHERE id = ?")
      .run(name, Number(request.params.id));
    if (!result.changes)
      return response.status(404).json({ error: "College not found." });
    response.json({ colleges: getLeaderboard() });
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE")
      return response
        .status(409)
        .json({ error: "That college already exists." });
    throw error;
  }
});

app.post("/api/admin/points", requireAdmin, (request, response) => {
  const collegeId = Number(request.body?.collegeId);
  const eventName = String(request.body?.eventName || "").trim();
  const points = Number(request.body?.points);
  if (
    !Number.isInteger(collegeId) ||
    !Number.isInteger(points) ||
    points < 1 ||
    points > 10000 ||
    !eventName ||
    eventName.length > 120
  ) {
    return response.status(400).json({
      error: "Provide a valid college, event name, and points value.",
    });
  }
  const college = database
    .prepare("SELECT id FROM colleges WHERE id = ?")
    .get(collegeId);
  if (!college)
    return response.status(404).json({ error: "College not found." });
  database
    .prepare(
      "INSERT INTO point_entries (college_id, event_name, points) VALUES (?, ?, ?)",
    )
    .run(collegeId, eventName, points);
  response.status(201).json({ colleges: getLeaderboard() });
});

app.post("/api/admin/adjust-points", requireAdmin, (request, response) => {
  const collegeId = Number(request.body?.collegeId);
  const points = Number(request.body?.points);
  const eventName = String(request.body?.eventName || "").trim();
  if (
    !Number.isInteger(collegeId) ||
    !Number.isInteger(points) ||
    points === 0 ||
    Math.abs(points) > 10000
  )
    return response
      .status(400)
      .json({ error: "Points adjustment must be a non-zero whole number." });
  const college = database
    .prepare("SELECT id FROM colleges WHERE id = ?")
    .get(collegeId);
  if (!college)
    return response.status(404).json({ error: "College not found." });

  if (eventName) {
    const currentTotal = getCollegeEventTotal(collegeId, eventName);
    if (currentTotal + points < 0) {
      return response
        .status(400)
        .json({ error: "Event points cannot go below zero." });
    }

    database
      .prepare(
        "INSERT INTO point_adjustments (college_id, event_name, points) VALUES (?, ?, ?)",
      )
      .run(collegeId, eventName, points);
  } else {
    const currentTotal = database
      .prepare(
        `
        SELECT
          COALESCE((SELECT SUM(points) FROM point_entries WHERE college_id = ?), 0)
          + COALESCE((SELECT SUM(points) FROM point_adjustments WHERE college_id = ?), 0) AS total
      `,
      )
      .get(collegeId, collegeId);

    if (Number(currentTotal?.total || 0) + points < 0) {
      return response
        .status(400)
        .json({ error: "College total cannot go below zero." });
    }

    database
      .prepare("INSERT INTO point_adjustments (college_id, points) VALUES (?, ?)")
      .run(collegeId, points);
  }

  response.status(201).json({ colleges: getLeaderboard() });
});

app.delete("/api/admin/events/:collegeId/:eventName", requireAdmin, (request, response) => {
  const collegeId = Number(request.params.collegeId);
  const eventName = decodeURIComponent(String(request.params.eventName || "")).trim();

  if (!Number.isInteger(collegeId) || !eventName) {
    return response.status(400).json({ error: "Invalid college or event name." });
  }

  database
    .prepare("DELETE FROM point_entries WHERE college_id = ? AND event_name = ?")
    .run(collegeId, eventName);
  database
    .prepare("DELETE FROM point_adjustments WHERE college_id = ? AND event_name = ?")
    .run(collegeId, eventName);

  response.json({ colleges: getLeaderboard() });
});

app.delete("/api/admin/colleges/:id", requireAdmin, (request, response) => {
  const result = database
    .prepare("DELETE FROM colleges WHERE id = ?")
    .run(Number(request.params.id));
  if (!result.changes)
    return response.status(404).json({ error: "College not found." });
  response.json({ colleges: getLeaderboard() });
});

app.post("/api/admin/reset", requireAdmin, (_request, response) => {
  database.prepare("DELETE FROM point_entries").run();
  database.prepare("DELETE FROM point_adjustments").run();
  response.json({ colleges: getLeaderboard() });
});

app.use(express.static(__dirname, { extensions: ["html"] }));
app.use((_request, response) =>
  response.sendFile(path.join(__dirname, "index.html")),
);

app.listen(port, () => {
  console.log(`RENDER 2.0 is running at http://localhost:${port}`);
});
