const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const multer = require("multer");
try {
  process.loadEnvFile(path.join(__dirname, ".env")); // optional: WhatsApp/SMS credentials
} catch {
  /* no .env file - click-to-send mode */
}
const { getDb, notify, nextBookingCode, now, normalizeTag, tagInUse, generateTag } = require("./db");
const rfid = require("./rfid");
const messaging = require("./messaging");

const PORT = process.env.PORT || 5174;
const JWT_SECRET = process.env.JWT_SECRET || "sportease-dev-secret-change-me";
// Shared secret the ESP32 sends in the X-Device-Key header. Set DEVICE_KEY in server/.env.
const DEFAULT_DEVICE_KEY = "sportease-device-demo-key";
const DEVICE_KEY = process.env.DEVICE_KEY || DEFAULT_DEVICE_KEY;
const UPLOADS = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || ".jpg") || ".jpg";
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 4 * 1024 * 1024 } });

const db = getDb();
const app = express();
const corsOptions = {
  origin: "*",
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Device-Key"],
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json({ limit: "2mb" }));
app.use("/uploads", express.static(UPLOADS));

function sign(user) {
  return jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: "7d" });
}

function publicUser(row) {
  if (!row) return null;
  const { password_hash, ...rest } = row;
  return rest;
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Your session has expired." });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
    if (!row || row.account_status !== "active") {
      return res.status(401).json({ error: "Your session has expired." });
    }
    req.account = row;
    next();
  } catch {
    return res.status(401).json({ error: "Your session has expired." });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "You do not have access to this area." });
  }
  next();
}

function setting(key) {
  return db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value;
}

// Run a route and turn HttpError (from rfid.js) into a clean JSON response.
const wrap = (fn) => (req, res) => {
  try {
    fn(req, res);
  } catch (e) {
    if (e instanceof rfid.HttpError) return res.status(e.status).json({ error: e.message, ...e.extra });
    console.error(e);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
};

function notifyAdmins(title, message, bookingId = null) {
  for (const a of db.prepare("SELECT id FROM users WHERE role = 'admin' AND account_status = 'active'").all()) {
    notify(db, a.id, title, message, "System", bookingId);
  }
}

const ACTIVE_BOOKING_STATUSES = ["Pending", "Approved", "Active"];

function overlaps({ equipment_id, ground_id, booking_date, start_time, end_time, excludeId }) {
  const clauses = [
    "booking_date = ?",
    "status IN ('Pending','Approved','Active')",
    "start_time < ?",
    "end_time > ?",
  ];
  const params = [booking_date, end_time, start_time];
  if (equipment_id) {
    clauses.push("equipment_id = ?");
    params.push(equipment_id);
  } else {
    clauses.push("ground_id = ?");
    params.push(ground_id);
  }
  if (excludeId) {
    clauses.push("id != ?");
    params.push(excludeId);
  }
  return db
    .prepare(`SELECT * FROM bookings WHERE ${clauses.join(" AND ")} ORDER BY start_time`)
    .all(...params);
}

function userOverlap(user_id, booking_date, start_time, end_time, equipment_id, excludeId) {
  const params = [user_id, booking_date, end_time, start_time, equipment_id];
  let sql = `SELECT * FROM bookings
    WHERE user_id = ? AND booking_date = ? AND status IN ('Pending','Approved','Active')
    AND start_time < ? AND end_time > ? AND equipment_id = ?`;
  if (excludeId) {
    sql += " AND id != ?";
    params.push(excludeId);
  }
  return db.prepare(sql).all(...params);
}

function validateWindow(start, end) {
  if (!start || !end || end <= start) return "Please select a valid time.";
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const mins = eh * 60 + em - (sh * 60 + sm);
  const minDur = Number(setting("min_duration_minutes") || 60);
  const maxHrs = Number(setting("max_duration_hours") || 3);
  if (mins < minDur) return `Booking duration must be at least ${minDur} minutes.`;
  if (mins > maxHrs * 60) return `Booking duration cannot exceed ${maxHrs} hours.`;
  return null;
}

function withinHours(ground, start, end) {
  if (!ground) return true;
  return start >= ground.opening_time && end <= ground.closing_time;
}

function alternatives(kind, id, date, opening, closing) {
  const slots = db.prepare("SELECT * FROM time_slots WHERE active = 1 ORDER BY start_time").all();
  return slots
    .filter((s) => (!opening || s.start_time >= opening) && (!closing || s.end_time <= closing))
    .map((s) => {
      const hits = overlaps({
        equipment_id: kind === "equipment" ? id : null,
        ground_id: kind === "ground" ? id : null,
        booking_date: date,
        start_time: s.start_time,
        end_time: s.end_time,
      });
      return { ...s, available: hits.length === 0 };
    });
}

function bookingPayload(row) {
  if (!row) return null;
  const user = publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(row.user_id));
  const sport = db.prepare("SELECT * FROM sports WHERE id = ?").get(row.sport_id);
  const equipment = row.equipment_id
    ? db.prepare("SELECT * FROM equipment WHERE id = ?").get(row.equipment_id)
    : null;
  const ground = row.ground_id
    ? db.prepare("SELECT * FROM grounds WHERE id = ?").get(row.ground_id)
    : null;
  const tx = db
    .prepare(
      `SELECT * FROM equipment_transactions WHERE booking_id = ? ORDER BY id DESC LIMIT 1`
    )
    .get(row.id);
  return {
    ...row,
    user,
    sport,
    equipment,
    ground,
    transaction: tx || null,
  };
}

app.post("/api/auth/register", (req, res) => {
  const { full_name, email, password, confirm_password, student_id, phone, department, year } =
    req.body || {};
  const errors = {};
  if (!full_name) errors.full_name = "Full name is required.";
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = "Enter a valid email.";
  if (!student_id) errors.student_id = "Student ID is required.";
  if (!phone) errors.phone = "Phone is required.";
  if (!department) errors.department = "Department is required.";
  if (!year) errors.year = "Year is required.";
  if (!password || password.length < 8) errors.password = "Password must be at least 8 characters.";
  else if (!/[A-Za-z]/.test(password) || !/\d/.test(password))
    errors.password = "Use letters and numbers for a stronger password.";
  if (password !== confirm_password) errors.confirm_password = "Passwords do not match.";
  if (email && db.prepare("SELECT id FROM users WHERE email = ?").get(String(email).toLowerCase())) {
    errors.email = "That email is already registered.";
  }
  if (student_id && db.prepare("SELECT id FROM users WHERE student_id = ?").get(student_id)) {
    errors.student_id = "That student ID is already registered.";
  }
  if (Object.keys(errors).length) return res.status(400).json({ error: "Please fix the highlighted fields.", errors });

  const info = db
    .prepare(
      `INSERT INTO users (full_name, email, password_hash, student_id, phone, department, year, role, account_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'student', 'active', ?, ?)`
    )
    .run(
      full_name.trim(),
      String(email).toLowerCase(),
      bcrypt.hashSync(password, 10),
      student_id.trim(),
      phone.trim(),
      department.trim(),
      String(year),
      now(),
      now()
    );
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
  notify(db, user.id, "Welcome to SportEase", "Your account is ready. Start by exploring sports.", "System");
  res.json({ token: sign(user), user: publicUser(user) });
});

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(String(email || "").toLowerCase());
  if (!user || !bcrypt.compareSync(password || "", user.password_hash)) {
    return res.status(400).json({ error: "Email or password is incorrect." });
  }
  if (user.account_status !== "active") {
    return res.status(403).json({ error: "This account is inactive. Contact athletics staff." });
  }
  res.json({ token: sign(user), user: publicUser(user) });
});

app.get("/api/auth/me", auth, (req, res) => {
  res.json({ user: publicUser(req.account) });
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "sportease-api" });
});

app.put("/api/auth/profile", auth, (req, res) => {
  const { full_name, phone, department, year, profile_image } = req.body || {};
  db.prepare(
    `UPDATE users SET full_name = ?, phone = ?, department = ?, year = ?, profile_image = ?, updated_at = ? WHERE id = ?`
  ).run(
    full_name || req.account.full_name,
    phone ?? req.account.phone,
    department ?? req.account.department,
    year ?? req.account.year,
    profile_image ?? req.account.profile_image,
    now(),
    req.user.id
  );
  res.json({ user: publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id)) });
});

app.put("/api/auth/password", auth, (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!bcrypt.compareSync(current_password || "", req.account.password_hash)) {
    return res.status(400).json({ error: "Current password is incorrect." });
  }
  if (!new_password || new_password.length < 8) {
    return res.status(400).json({ error: "New password must be at least 8 characters." });
  }
  db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(
    bcrypt.hashSync(new_password, 10),
    now(),
    req.user.id
  );
  res.json({ ok: true });
});

app.post("/api/upload", auth, adminOnly, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Please choose an image." });
  res.json({ url: `/uploads/${req.file.filename}` });
});

app.get("/api/sports", auth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT s.*,
        (SELECT COUNT(*) FROM equipment e WHERE e.sport_id = s.id) AS equipment_count,
        (SELECT COUNT(*) FROM equipment e WHERE e.sport_id = s.id AND e.status IN ('Available','Partially Available')) AS available_count
       FROM sports s ORDER BY name`
    )
    .all();
  res.json(rows);
});

app.post("/api/sports", auth, adminOnly, (req, res) => {
  const { name, description, icon, image, status } = req.body || {};
  if (!name) return res.status(400).json({ error: "Sport name is required." });
  try {
    const info = db
      .prepare(
        `INSERT INTO sports (name, description, icon, image, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(name, description || "", icon || "🏅", image || "", status || "active", now());
    res.json(db.prepare("SELECT * FROM sports WHERE id = ?").get(info.lastInsertRowid));
  } catch {
    res.status(400).json({ error: "A sport with that name already exists." });
  }
});

app.put("/api/sports/:id", auth, adminOnly, (req, res) => {
  const { name, description, icon, image, status } = req.body || {};
  db.prepare(
    `UPDATE sports SET name = ?, description = ?, icon = ?, image = ?, status = ? WHERE id = ?`
  ).run(name, description, icon, image, status || "active", req.params.id);
  res.json(db.prepare("SELECT * FROM sports WHERE id = ?").get(req.params.id));
});

app.delete("/api/sports/:id", auth, adminOnly, (req, res) => {
  db.prepare(`UPDATE sports SET status = 'inactive' WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

app.get("/api/categories", auth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.*, s.name AS sport_name FROM equipment_categories c JOIN sports s ON s.id = c.sport_id ORDER BY s.name, c.name`
    )
    .all();
  res.json(rows);
});

app.post("/api/categories", auth, adminOnly, (req, res) => {
  const { sport_id, name, description } = req.body || {};
  if (!sport_id || !name) return res.status(400).json({ error: "Sport and name are required." });
  const info = db
    .prepare(
      `INSERT INTO equipment_categories (sport_id, name, description, created_at) VALUES (?, ?, ?, ?)`
    )
    .run(sport_id, name, description || "", now());
  res.json(db.prepare("SELECT * FROM equipment_categories WHERE id = ?").get(info.lastInsertRowid));
});

app.put("/api/categories/:id", auth, adminOnly, (req, res) => {
  const { sport_id, name, description } = req.body || {};
  db.prepare(`UPDATE equipment_categories SET sport_id = ?, name = ?, description = ? WHERE id = ?`).run(
    sport_id,
    name,
    description || "",
    req.params.id
  );
  res.json(db.prepare("SELECT * FROM equipment_categories WHERE id = ?").get(req.params.id));
});

app.delete("/api/categories/:id", auth, adminOnly, (req, res) => {
  db.prepare("DELETE FROM equipment_categories WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

app.get("/api/equipment", auth, (req, res) => {
  const { q, sport_id, category_id, status, condition, sort } = req.query;
  let sql = `SELECT e.*, s.name AS sport_name, c.name AS category_name
             FROM equipment e
             JOIN sports s ON s.id = e.sport_id
             LEFT JOIN equipment_categories c ON c.id = e.category_id
             WHERE 1=1`;
  const params = [];
  if (q) {
    sql += ` AND (e.name LIKE ? OR e.equipment_code LIKE ? OR e.serial_number LIKE ?)`;
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (sport_id) {
    sql += " AND e.sport_id = ?";
    params.push(sport_id);
  }
  if (category_id) {
    sql += " AND e.category_id = ?";
    params.push(category_id);
  }
  if (status) {
    sql += " AND e.status = ?";
    params.push(status);
  }
  if (condition) {
    sql += " AND e.condition = ?";
    params.push(condition);
  }
  if (sort === "availability") sql += " ORDER BY e.available_quantity DESC, e.name";
  else if (sort === "recent") sql += " ORDER BY e.created_at DESC";
  else sql += " ORDER BY e.name, e.equipment_code";
  res.json(db.prepare(sql).all(...params));
});

app.get("/api/equipment/:id", auth, (req, res) => {
  const row = db
    .prepare(
      `SELECT e.*, s.name AS sport_name, c.name AS category_name
       FROM equipment e JOIN sports s ON s.id = e.sport_id
       LEFT JOIN equipment_categories c ON c.id = e.category_id WHERE e.id = ?`
    )
    .get(req.params.id);
  if (!row) return res.status(404).json({ error: "Equipment is no longer available." });
  res.json(row);
});

app.get("/api/equipment/:id/availability", auth, (req, res) => {
  const eq = db.prepare("SELECT * FROM equipment WHERE id = ?").get(req.params.id);
  if (!eq) return res.status(404).json({ error: "Equipment is no longer available." });
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  res.json({
    equipment: eq,
    date,
    bookable: !["Maintenance", "Damaged", "Lost", "Issued"].includes(eq.status),
    slots: alternatives("equipment", eq.id, date),
  });
});

app.post("/api/equipment", auth, adminOnly, (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.sport_id || !b.equipment_code) {
    return res.status(400).json({ error: "Name, sport, and equipment code are required." });
  }
  const exists = db.prepare("SELECT id FROM equipment WHERE equipment_code = ?").get(b.equipment_code);
  if (exists) return res.status(400).json({ error: "Equipment code must be unique." });
  const qty = Number(b.quantity || 1);
  let tag = normalizeTag(b.rfid_tag);
  if (tag && tagInUse(db, tag)) return res.status(400).json({ error: `RFID tag ${tag} is already assigned. Every item needs its own tag.` });
  if (!tag) tag = generateTag(db, "EQ");
  const info = db
    .prepare(
      `INSERT INTO equipment (category_id, sport_id, name, equipment_code, serial_number, quantity, available_quantity, condition, status, image, description, purchase_date, created_at, updated_at, rfid_tag)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      b.category_id || null,
      b.sport_id,
      b.name.trim(),
      b.equipment_code.trim().toUpperCase(),
      b.serial_number || "",
      qty,
      Number(b.available_quantity ?? qty),
      b.condition || "Good",
      b.status || "Available",
      b.image || "",
      b.description || "",
      b.purchase_date || null,
      now(),
      now(),
      tag
    );
  res.json(db.prepare("SELECT * FROM equipment WHERE id = ?").get(info.lastInsertRowid));
});

app.put("/api/equipment/:id", auth, adminOnly, (req, res) => {
  const b = req.body || {};
  const current = db.prepare("SELECT * FROM equipment WHERE id = ?").get(req.params.id);
  if (!current) return res.status(404).json({ error: "Equipment not found." });
  if (b.equipment_code) {
    const clash = db
      .prepare("SELECT id FROM equipment WHERE equipment_code = ? AND id != ?")
      .get(b.equipment_code.trim().toUpperCase(), req.params.id);
    if (clash) return res.status(400).json({ error: "Equipment code must be unique." });
  }
  let newTag = current.rfid_tag;
  if (b.rfid_tag !== undefined) {
    newTag = normalizeTag(b.rfid_tag) || current.rfid_tag || generateTag(db, "EQ");
    if (tagInUse(db, newTag, { exceptEquipmentId: current.id })) {
      return res.status(400).json({ error: `RFID tag ${newTag} is already assigned. Every item needs its own tag.` });
    }
  }
  db.prepare(
    `UPDATE equipment SET category_id=?, sport_id=?, name=?, equipment_code=?, serial_number=?, quantity=?,
     available_quantity=?, condition=?, status=?, image=?, description=?, purchase_date=?, updated_at=?, rfid_tag=? WHERE id=?`
  ).run(
    b.category_id ?? current.category_id,
    b.sport_id ?? current.sport_id,
    (b.name ?? current.name).trim(),
    (b.equipment_code ?? current.equipment_code).trim().toUpperCase(),
    b.serial_number ?? current.serial_number,
    b.quantity ?? current.quantity,
    b.available_quantity ?? current.available_quantity,
    b.condition ?? current.condition,
    b.status ?? current.status,
    b.image ?? current.image,
    b.description ?? current.description,
    b.purchase_date ?? current.purchase_date,
    now(),
    newTag,
    req.params.id
  );
  res.json(db.prepare("SELECT * FROM equipment WHERE id = ?").get(req.params.id));
});

app.delete("/api/equipment/:id", auth, adminOnly, (req, res) => {
  db.prepare(`UPDATE equipment SET status = 'Lost', available_quantity = 0, updated_at = ? WHERE id = ?`).run(
    now(),
    req.params.id
  );
  res.json({ ok: true });
});

app.get("/api/grounds", auth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT g.*, s.name AS sport_name FROM grounds g JOIN sports s ON s.id = g.sport_id ORDER BY g.name`
    )
    .all();
  res.json(rows);
});

app.get("/api/grounds/:id", auth, (req, res) => {
  const row = db
    .prepare(
      `SELECT g.*, s.name AS sport_name FROM grounds g JOIN sports s ON s.id = g.sport_id WHERE g.id = ?`
    )
    .get(req.params.id);
  if (!row) return res.status(404).json({ error: "Ground not found." });
  res.json(row);
});

app.get("/api/grounds/:id/availability", auth, (req, res) => {
  const g = db.prepare("SELECT * FROM grounds WHERE id = ?").get(req.params.id);
  if (!g) return res.status(404).json({ error: "Ground not found." });
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  res.json({
    ground: g,
    date,
    bookable: g.status === "active",
    slots: alternatives("ground", g.id, date, g.opening_time, g.closing_time),
  });
});

app.post("/api/grounds", auth, adminOnly, (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.sport_id) return res.status(400).json({ error: "Name and sport are required." });
  const info = db
    .prepare(
      `INSERT INTO grounds (sport_id, name, location, capacity, description, image, status, opening_time, closing_time, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      b.sport_id,
      b.name,
      b.location || "",
      b.capacity || 0,
      b.description || "",
      b.image || "",
      b.status || "active",
      b.opening_time || "07:00",
      b.closing_time || "20:00",
      now()
    );
  res.json(db.prepare("SELECT * FROM grounds WHERE id = ?").get(info.lastInsertRowid));
});

app.put("/api/grounds/:id", auth, adminOnly, (req, res) => {
  const b = req.body || {};
  db.prepare(
    `UPDATE grounds SET sport_id=?, name=?, location=?, capacity=?, description=?, image=?, status=?, opening_time=?, closing_time=? WHERE id=?`
  ).run(
    b.sport_id,
    b.name,
    b.location,
    b.capacity,
    b.description,
    b.image,
    b.status,
    b.opening_time,
    b.closing_time,
    req.params.id
  );
  res.json(db.prepare("SELECT * FROM grounds WHERE id = ?").get(req.params.id));
});

app.delete("/api/grounds/:id", auth, adminOnly, (req, res) => {
  db.prepare(`UPDATE grounds SET status = 'inactive' WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

app.get("/api/slots", auth, (_req, res) => {
  res.json(db.prepare("SELECT * FROM time_slots ORDER BY start_time").all());
});

app.post("/api/slots", auth, adminOnly, (req, res) => {
  const { label, start_time, end_time } = req.body || {};
  if (!label || !start_time || !end_time) return res.status(400).json({ error: "Please complete the slot." });
  const info = db
    .prepare(`INSERT INTO time_slots (label, start_time, end_time, active) VALUES (?, ?, ?, 1)`)
    .run(label, start_time, end_time);
  res.json(db.prepare("SELECT * FROM time_slots WHERE id = ?").get(info.lastInsertRowid));
});

app.put("/api/slots/:id", auth, adminOnly, (req, res) => {
  const { label, start_time, end_time, active } = req.body || {};
  db.prepare(`UPDATE time_slots SET label=?, start_time=?, end_time=?, active=? WHERE id=?`).run(
    label,
    start_time,
    end_time,
    active ? 1 : 0,
    req.params.id
  );
  res.json(db.prepare("SELECT * FROM time_slots WHERE id = ?").get(req.params.id));
});

app.delete("/api/slots/:id", auth, adminOnly, (req, res) => {
  db.prepare("DELETE FROM time_slots WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

app.get("/api/bookings", auth, (req, res) => {
  const { status, sport_id, date, user_id, q, scope } = req.query;
  let sql = `SELECT b.* FROM bookings b WHERE 1=1`;
  const params = [];
  if (req.user.role !== "admin" || scope === "mine") {
    sql += " AND b.user_id = ?";
    params.push(req.user.id);
  } else if (user_id) {
    sql += " AND b.user_id = ?";
    params.push(user_id);
  }
  if (status) {
    sql += " AND b.status = ?";
    params.push(status);
  }
  if (sport_id) {
    sql += " AND b.sport_id = ?";
    params.push(sport_id);
  }
  if (date) {
    sql += " AND b.booking_date = ?";
    params.push(date);
  }
  if (q) {
    sql += " AND (b.booking_code LIKE ? OR b.rfid_tag LIKE ?)";
    params.push(`%${q}%`, `%${normalizeTag(q)}%`);
  }
  sql += " ORDER BY b.booking_date DESC, b.start_time DESC";
  res.json(db.prepare(sql).all(...params).map(bookingPayload));
});

app.get("/api/bookings/lookup", auth, adminOnly, (req, res) => {
  const raw = String(req.query.q || "").trim();
  if (!raw) return res.status(400).json({ error: "Scan a booking QR or enter a code." });
  let code = raw;
  try {
    const parsed = JSON.parse(raw);
    code = String(parsed.bookingCode || parsed.bookingId || raw);
  } catch {
    /* plain code */
  }
  const asId = Number(code);
  const row = db
    .prepare(`SELECT * FROM bookings WHERE booking_code = ? OR rfid_tag = ? OR id = ?`)
    .get(code, normalizeTag(code), Number.isFinite(asId) ? asId : -1);
  if (!row) return res.status(404).json({ error: "Booking not found." });
  res.json(bookingPayload(row));
});

app.get("/api/bookings/:id", auth, (req, res) => {
  const row = db.prepare("SELECT * FROM bookings WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Booking not found." });
  if (req.user.role !== "admin" && row.user_id !== req.user.id) {
    return res.status(403).json({ error: "You do not have access to this area." });
  }
  res.json(bookingPayload(row));
});

app.post("/api/bookings", auth, (req, res) => {
  const { equipment_id, ground_id, booking_date, start_time, end_time, purpose, override } =
    req.body || {};
  if (!booking_date || !start_time || !end_time) {
    return res.status(400).json({ error: "Please select a date and time." });
  }
  if (!equipment_id && !ground_id) {
    return res.status(400).json({ error: "Select equipment or a ground." });
  }
  const today = new Date().toISOString().slice(0, 10);
  if (booking_date < today) return res.status(400).json({ error: "Date cannot be in the past." });
  const windowErr = validateWindow(start_time, end_time);
  if (windowErr) return res.status(400).json({ error: windowErr });

  const isAdminOverride = req.user.role === "admin" && override;
  const equipment = equipment_id
    ? db.prepare("SELECT * FROM equipment WHERE id = ?").get(equipment_id)
    : null;
  const ground = ground_id ? db.prepare("SELECT * FROM grounds WHERE id = ?").get(ground_id) : null;

  if (equipment_id) {
    if (!equipment) return res.status(400).json({ error: "Equipment is no longer available." });
    if (!isAdminOverride) {
      if (["Maintenance", "Damaged", "Lost", "Issued"].includes(equipment.status) || equipment.available_quantity < 1) {
        return res.status(400).json({ error: "Equipment is no longer available." });
      }
    }
  }
  if (ground_id) {
    if (!ground || ground.status !== "active") {
      return res.status(400).json({ error: "This ground is not available." });
    }
    if (!isAdminOverride && !withinHours(ground, start_time, end_time)) {
      return res.status(400).json({ error: "Bookings must stay within opening hours." });
    }
  }

  const sport_id = equipment?.sport_id || ground?.sport_id;
  const maxActive = Number(setting("max_active_bookings") || 3);
  if (req.user.role !== "admin") {
    const activeCount = db
      .prepare(
        `SELECT COUNT(*) AS c FROM bookings WHERE user_id = ? AND status IN ('Pending','Approved','Active')`
      )
      .get(req.user.id).c;
    if (activeCount >= maxActive) {
      return res.status(400).json({ error: `You can have at most ${maxActive} active bookings.` });
    }
  }

  const conflicts = overlaps({ equipment_id, ground_id, booking_date, start_time, end_time });
  if (conflicts.length && !isAdminOverride) {
    const item = equipment || ground;
    const code = equipment?.equipment_code ? ` ${equipment.equipment_code}` : "";
    return res.status(409).json({
      error: equipment_id ? "Equipment Already Booked" : "Ground Already Booked",
      detail: `${item.name}${code} is unavailable from ${start_time} to ${end_time}.`,
      alternatives: alternatives(
        equipment_id ? "equipment" : "ground",
        equipment_id || ground_id,
        booking_date,
        ground?.opening_time,
        ground?.closing_time
      ),
    });
  }

  if (equipment_id && userOverlap(req.user.id, booking_date, start_time, end_time, equipment_id).length) {
    return res.status(409).json({ error: "You already have this equipment booked for an overlapping time." });
  }

  const requireApproval = setting("require_approval") !== "0";
  const status = req.user.role === "admin" || !requireApproval ? "Approved" : "Pending";
  const info = db
    .prepare(
      `INSERT INTO bookings (booking_code, user_id, equipment_id, ground_id, sport_id, booking_date, start_time, end_time, purpose, status, admin_notes, created_at, updated_at, rfid_tag)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      nextBookingCode(db),
      req.user.id,
      equipment_id || null,
      ground_id || null,
      sport_id,
      booking_date,
      start_time,
      end_time,
      purpose || "",
      status,
      isAdminOverride ? "Admin override" : null,
      now(),
      now(),
      generateTag(db, "BK")
    );
  const booking = bookingPayload(db.prepare("SELECT * FROM bookings WHERE id = ?").get(info.lastInsertRowid));
  if (status === "Approved") {
    notify(
      db,
      req.user.id,
      "Booking confirmed",
      `${booking.booking_code} is approved.`,
      "Booking Approved",
      booking.id
    );
  } else {
    notify(
      db,
      req.user.id,
      "Booking submitted",
      `${booking.booking_code} is pending approval.`,
      "System",
      booking.id
    );
  }
  if (req.user.role !== "admin") {
    notifyAdmins(
      "New booking",
      `${booking.user?.full_name} booked ${booking.equipment?.name || booking.ground?.name} on ${booking.booking_date} ${booking.start_time}-${booking.end_time} (${booking.booking_code}).`,
      booking.id
    );
  }
  messaging.dispatchBookingEvent(db, booking, status === "Approved" ? "approved" : "created", {
    createdBy: req.user.id,
    alertAdmin: req.user.role !== "admin",
  });
  res.json(booking);
});

app.post("/api/bookings/:id/cancel", auth, (req, res) => {
  const row = db.prepare("SELECT * FROM bookings WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Booking not found." });
  if (req.user.role !== "admin" && row.user_id !== req.user.id) {
    return res.status(403).json({ error: "You do not have access to this area." });
  }
  if (!["Pending", "Approved"].includes(row.status) && req.user.role !== "admin") {
    return res.status(400).json({ error: "This booking can no longer be cancelled." });
  }
  db.prepare(`UPDATE bookings SET status = 'Cancelled', updated_at = ?, admin_notes = COALESCE(admin_notes, ?) WHERE id = ?`).run(
    now(),
    req.body?.reason || "Cancelled",
    row.id
  );
  notify(db, row.user_id, "Booking cancelled", `${row.booking_code} was cancelled.`, "Booking Cancelled", row.id);
  const cancelled = bookingPayload(db.prepare("SELECT * FROM bookings WHERE id = ?").get(row.id));
  messaging.dispatchBookingEvent(db, cancelled, "cancelled", { createdBy: req.user.id });
  res.json(cancelled);
});

app.post("/api/bookings/:id/approve", auth, adminOnly, (req, res) => {
  const row = db.prepare("SELECT * FROM bookings WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Booking not found." });
  const conflicts = overlaps({
    equipment_id: row.equipment_id,
    ground_id: row.ground_id,
    booking_date: row.booking_date,
    start_time: row.start_time,
    end_time: row.end_time,
    excludeId: row.id,
  });
  if (conflicts.length) {
    return res.status(409).json({ error: "Booking time overlaps with another booking." });
  }
  db.prepare(`UPDATE bookings SET status = 'Approved', admin_notes = ?, updated_at = ? WHERE id = ?`).run(
    req.body?.admin_notes || "Approved",
    now(),
    row.id
  );
  notify(
    db,
    row.user_id,
    "Your booking was approved.",
    `${row.booking_code} is confirmed. Show the QR code when collecting equipment.`,
    "Booking Approved",
    row.id
  );
  const approved = bookingPayload(db.prepare("SELECT * FROM bookings WHERE id = ?").get(row.id));
  messaging.dispatchBookingEvent(db, approved, "approved", { createdBy: req.user.id });
  res.json(approved);
});

app.post("/api/bookings/:id/reject", auth, adminOnly, (req, res) => {
  const row = db.prepare("SELECT * FROM bookings WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Booking not found." });
  const reason = req.body?.reason || "Rejected by athletics staff";
  db.prepare(`UPDATE bookings SET status = 'Rejected', admin_notes = ?, updated_at = ? WHERE id = ?`).run(
    reason,
    now(),
    row.id
  );
  notify(db, row.user_id, "Your booking was rejected.", reason, "Booking Rejected", row.id);
  const rejected = bookingPayload(db.prepare("SELECT * FROM bookings WHERE id = ?").get(row.id));
  messaging.dispatchBookingEvent(db, rejected, "rejected", { createdBy: req.user.id, extra: `Reason: ${reason}` });
  res.json(rejected);
});

app.get("/api/transactions", auth, (req, res) => {
  let sql = `SELECT t.*, e.name AS equipment_name, e.equipment_code, e.rfid_tag AS equipment_rfid, u.full_name AS student_name, u.student_id,
             b.booking_code, b.booking_date, b.start_time, b.end_time
             FROM equipment_transactions t
             JOIN equipment e ON e.id = t.equipment_id
             JOIN users u ON u.id = t.issued_to
             LEFT JOIN bookings b ON b.id = t.booking_id`;
  const params = [];
  if (req.user.role !== "admin") {
    sql += " WHERE t.issued_to = ?";
    params.push(req.user.id);
  }
  sql += " ORDER BY t.id DESC";
  res.json(db.prepare(sql).all(...params));
});

function bookingById(id) {
  return bookingPayload(db.prepare("SELECT * FROM bookings WHERE id = ?").get(id));
}

// Manual issue (booking code / QR / button). The RFID desk uses /api/rfid/issue instead.
app.post(
  "/api/transactions/issue",
  auth,
  adminOnly,
  wrap((req, res) => {
    const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(req.body?.booking_id);
    if (!booking) throw new rfid.HttpError(400, "This booking cannot be issued.");
    const tx = rfid.issueBooking(db, booking, req.user.id);
    rfid.logScan(db, { tag: booking.rfid_tag || "-", tag_type: "booking", action: "issue", result: "ok", message: "Issued manually (no card scan)", booking_id: booking.id, equipment_id: booking.equipment_id, admin_id: req.user.id });
    messaging.dispatchBookingEvent(db, bookingById(booking.id), "issued", { createdBy: req.user.id });
    res.json(tx);
  })
);

app.post(
  "/api/transactions/:id/return",
  auth,
  wrap((req, res) => {
    const tx = db.prepare("SELECT * FROM equipment_transactions WHERE id = ?").get(req.params.id);
    if (!tx) throw new rfid.HttpError(404, "Transaction not found.");
    const done = rfid.closeTransaction(db, tx, req.user, req.body || {});
    if (tx.booking_id) messaging.dispatchBookingEvent(db, bookingById(tx.booking_id), "returned", { createdBy: req.user.id });
    res.json(done);
  })
);

// ---------------- RFID ----------------
// 1) Look a tag up (booking card or equipment tag)
app.post(
  "/api/rfid/scan",
  auth,
  adminOnly,
  wrap((req, res) => {
    const raw = req.body?.tag;
    let hit;
    try {
      hit = rfid.resolveTag(db, raw);
    } catch (e) {
      rfid.logScan(db, { tag: normalizeTag(raw) || "-", action: "scan", result: "error", message: e.message, admin_id: req.user.id });
      throw e;
    }
    rfid.logScan(db, {
      tag: hit.tag,
      tag_type: hit.type,
      action: "scan",
      result: hit.type === "unknown" ? "unknown" : "ok",
      message: hit.type === "unknown" ? "Tag not registered" : "Tag recognised",
      booking_id: hit.booking?.id,
      equipment_id: hit.equipment?.id,
      admin_id: req.user.id,
    });
    if (hit.type === "unknown") return res.status(404).json({ error: `Tag ${hit.tag} is not registered to any booking or equipment.`, type: "unknown", tag: hit.tag });
    if (hit.type === "booking") return res.json({ type: "booking", tag: hit.tag, booking: bookingPayload(hit.booking) });
    const holder = hit.openTransaction
      ? db
          .prepare(
            `SELECT u.full_name, u.student_id, b.booking_code FROM users u LEFT JOIN bookings b ON b.id = ? WHERE u.id = ?`
          )
          .get(hit.openTransaction.booking_id, hit.openTransaction.issued_to)
      : null;
    res.json({ type: "equipment", tag: hit.tag, equipment: hit.equipment, openTransaction: hit.openTransaction, holder });
  })
);

// 2) Issue: booking card + equipment tag must match
app.post(
  "/api/rfid/issue",
  auth,
  adminOnly,
  wrap((req, res) => {
    const { booking_tag, equipment_tag } = req.body || {};
    try {
      const tx = rfid.issueByTags(db, booking_tag, equipment_tag, req.user.id);
      const b = db.prepare("SELECT * FROM bookings WHERE id = ?").get(tx.booking_id);
      rfid.logScan(db, { tag: normalizeTag(equipment_tag), tag_type: "equipment", action: "issue", result: "ok", message: `Issued against ${b.booking_code}`, booking_id: b.id, equipment_id: tx.equipment_id, admin_id: req.user.id });
      messaging.dispatchBookingEvent(db, bookingById(b.id), "issued", { createdBy: req.user.id });
      res.json({ transaction: tx, booking: bookingById(b.id) });
    } catch (e) {
      rfid.logScan(db, { tag: normalizeTag(equipment_tag) || "-", tag_type: "equipment", action: "issue", result: "denied", message: e.message, admin_id: req.user.id });
      throw e;
    }
  })
);

// 3) Return: tap the equipment tag only
app.post(
  "/api/rfid/return",
  auth,
  adminOnly,
  wrap((req, res) => {
    const { equipment_tag, condition_after, remarks } = req.body || {};
    try {
      const tx = rfid.returnByTag(db, equipment_tag, req.user, { condition_after, remarks });
      rfid.logScan(db, { tag: normalizeTag(equipment_tag), tag_type: "equipment", action: "return", result: "ok", message: `Returned as ${tx.condition_after}`, booking_id: tx.booking_id, equipment_id: tx.equipment_id, admin_id: req.user.id });
      if (tx.booking_id) messaging.dispatchBookingEvent(db, bookingById(tx.booking_id), "returned", { createdBy: req.user.id });
      res.json(tx);
    } catch (e) {
      rfid.logScan(db, { tag: normalizeTag(equipment_tag) || "-", tag_type: "equipment", action: "return", result: "denied", message: e.message, admin_id: req.user.id });
      throw e;
    }
  })
);

// 4) Give a booking a physical card (replace the auto-generated virtual tag)
app.put(
  "/api/bookings/:id/rfid",
  auth,
  adminOnly,
  wrap((req, res) => {
    const row = db.prepare("SELECT * FROM bookings WHERE id = ?").get(req.params.id);
    if (!row) throw new rfid.HttpError(404, "Booking not found.");
    const tag = normalizeTag(req.body?.tag);
    if (!tag) throw new rfid.HttpError(400, "Scan or type the card tag.");
    if (tagInUse(db, tag, { exceptBookingId: row.id })) throw new rfid.HttpError(400, `Tag ${tag} is already assigned to something else.`);
    db.prepare("UPDATE bookings SET rfid_tag = ?, updated_at = ? WHERE id = ?").run(tag, now(), row.id);
    rfid.logScan(db, { tag, tag_type: "booking", action: "assign", result: "ok", message: `Card assigned to ${row.booking_code}`, booking_id: row.id, admin_id: req.user.id });
    res.json(bookingById(row.id));
  })
);

app.get("/api/rfid/logs", auth, adminOnly, (_req, res) => {
  res.json(db.prepare("SELECT * FROM rfid_logs ORDER BY id DESC LIMIT 60").all());
});

// ---------------- Smart locker device (ESP32 + RC522) ----------------
// The reader is not a logged-in person, so it authenticates with a shared device key.
function deviceAuth(req, res, next) {
  const given = Buffer.from(String(req.headers["x-device-key"] || ""));
  const wanted = Buffer.from(DEVICE_KEY);
  if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) {
    return res.status(401).json({ ok: false, unlock: false, message: "Invalid device key." });
  }
  next();
}

// Health check: the ESP32 can call this at start-up to confirm Wi-Fi + server + key.
app.get("/api/device/ping", deviceAuth, (_req, res) => {
  res.json({ ok: true, time: now() });
});

// One tap of a student's RFID ID card. Replies { ok, action, unlock, message }.
// unlock:true  -> the ESP32 energises the relay and opens the locker latch.
// ok:false     -> the ESP32 shows "use the counter" (manual register fallback).
app.post(
  "/api/device/tap",
  deviceAuth,
  wrap((req, res) => {
    const { card_uid, device_id } = req.body || {};
    const out = rfid.studentTap(db, card_uid);
    const { user_id, ...body } = out;
    if (out.ok && out.booking_id) {
      try {
        messaging.dispatchBookingEvent(db, bookingById(out.booking_id), out.action === "issue" ? "issued" : "returned", { createdBy: user_id });
      } catch (e) {
        console.error("Message dispatch failed (locker still opens):", e.message); // never block the latch
      }
    }
    res.json({ ...body, device_id: device_id || null });
  })
);

// ---------------- Messages (WhatsApp / SMS / Email) ----------------
function decorate(row) {
  const user = row.user_id ? db.prepare("SELECT full_name, student_id, phone, email FROM users WHERE id = ?").get(row.user_id) : null;
  return { ...row, user, links: messaging.links(row.to_phone || user?.phone, user?.email, row.body) };
}

app.get("/api/messaging/status", auth, adminOnly, (_req, res) => {
  res.json(messaging.providerStatus());
});

app.get("/api/messages", auth, adminOnly, (_req, res) => {
  res.json(db.prepare("SELECT * FROM message_log ORDER BY id DESC LIMIT 100").all().map(decorate));
});

// Preview the text + links for one booking (used on the booking detail page)
app.get("/api/bookings/:id/message", auth, adminOnly, (req, res) => {
  const row = db.prepare("SELECT * FROM bookings WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Booking not found." });
  const b = bookingPayload(row);
  const text = messaging.bookingMessage(b, "custom");
  res.json({ text, links: messaging.links(b.user?.phone, b.user?.email, text), status: messaging.providerStatus() });
});

// Send a message about a booking. Body: { channel: whatsapp|sms|email, text }
app.post("/api/bookings/:id/send-message", auth, adminOnly, (req, res) => {
  const row = db.prepare("SELECT * FROM bookings WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Booking not found." });
  const b = bookingPayload(row);
  const channel = ["whatsapp", "sms", "email"].includes(req.body?.channel) ? req.body.channel : "whatsapp";
  const text = String(req.body?.text || "").trim() || messaging.bookingMessage(b, "custom");
  const msg = messaging.queueMessage(db, { userId: b.user_id, bookingId: b.id, channel, event: "custom", phone: b.user?.phone, email: b.user?.email, body: text, createdBy: req.user.id });
  notify(db, b.user_id, "Message from sports desk", text.split("\n").slice(0, 4).join(" · "), "System", b.id);
  res.json(decorate(msg));
});

// Free-text message to one student or all students (creates one log row each)
app.post("/api/messages/send", auth, adminOnly, (req, res) => {
  const { user_id, text, channel } = req.body || {};
  const body = String(text || "").trim();
  if (!body) return res.status(400).json({ error: "Write a message first." });
  const ch = ["whatsapp", "sms", "email"].includes(channel) ? channel : "whatsapp";
  const users =
    user_id === "all" || !user_id
      ? db.prepare("SELECT * FROM users WHERE role = 'student' AND account_status = 'active'").all()
      : [db.prepare("SELECT * FROM users WHERE id = ?").get(Number(user_id))].filter(Boolean);
  if (!users.length) return res.status(404).json({ error: "Student not found." });
  const out = users.map((u) =>
    decorate(messaging.queueMessage(db, { userId: u.id, channel: ch, event: "custom", phone: u.phone, email: u.email, body: `SportEase\n${body}`, createdBy: req.user.id }))
  );
  res.json({ sent: out.length, messages: out });
});

// Mark a click-to-send message as sent after the admin pressed send in WhatsApp/SMS/Email
app.post("/api/messages/:id/mark-sent", auth, adminOnly, (req, res) => {
  db.prepare("UPDATE message_log SET status = 'sent_manual' WHERE id = ? AND status IN ('manual','failed')").run(req.params.id);
  res.json(decorate(db.prepare("SELECT * FROM message_log WHERE id = ?").get(req.params.id)));
});

app.post("/api/notifications/test", auth, (_req, res) => {
  notify(
    db,
    _req.user.id,
    "Test notification",
    "If you can read this, notifications are working. Unread count should increase on the bell icon.",
    "System"
  );
  res.json({ ok: true });
});

app.get("/api/notifications", auth, (req, res) => {
  const rows = db
    .prepare(`SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 80`)
    .all(req.user.id);
  res.json(rows);
});

app.post("/api/notifications", auth, adminOnly, (req, res) => {
  const { user_id, title, message, type } = req.body || {};
  const heading = String(title || "").trim();
  const body = String(message || title || "").trim();
  if (!heading) return res.status(400).json({ error: "Enter a title." });
  if (!body) return res.status(400).json({ error: "Enter a message." });
  if (user_id === "all" || !user_id) {
    const users = db.prepare("SELECT id FROM users WHERE role = 'student' AND account_status = 'active'").all();
    const tx = db.transaction(() => {
      for (const u of users) notify(db, u.id, heading, body, type || "System");
    });
    tx();
    return res.json({ ok: true, sent: users.length });
  }
  notify(db, Number(user_id), heading, body, type || "System");
  res.json({ ok: true });
});

app.patch("/api/notifications/:id/read", auth, (req, res) => {
  db.prepare(`UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?`).run(
    req.params.id,
    req.user.id
  );
  res.json({ ok: true });
});

app.post("/api/notifications/read-all", auth, (req, res) => {
  db.prepare(`UPDATE notifications SET is_read = 1 WHERE user_id = ?`).run(req.user.id);
  res.json({ ok: true });
});

app.get("/api/users", auth, adminOnly, (req, res) => {
  const { q } = req.query;
  let sql = "SELECT * FROM users WHERE 1=1";
  const params = [];
  if (q) {
    sql += " AND (full_name LIKE ? OR email LIKE ? OR student_id LIKE ?)";
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  sql += " ORDER BY created_at DESC";
  res.json(db.prepare(sql).all(...params).map(publicUser));
});

app.put("/api/users/:id", auth, adminOnly, (req, res) => {
  const b = req.body || {};
  const current = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!current) return res.status(404).json({ error: "User not found." });
  let nextCard = current.rfid_tag;
  if (b.rfid_tag !== undefined) {
    const tag = normalizeTag(b.rfid_tag);
    if (tag && tagInUse(db, tag, { exceptUserId: current.id })) {
      return res.status(400).json({ error: `Card ${tag} is already assigned to something else.` });
    }
    nextCard = tag || null;
  }
  db.prepare(
    `UPDATE users SET full_name=?, phone=?, department=?, year=?, role=?, account_status=?, student_id=?, rfid_tag=?, updated_at=? WHERE id=?`
  ).run(
    b.full_name ?? current.full_name,
    b.phone ?? current.phone,
    b.department ?? current.department,
    b.year ?? current.year,
    b.role ?? current.role,
    b.account_status ?? current.account_status,
    b.student_id ?? current.student_id,
    nextCard,
    now(),
    req.params.id
  );
  res.json(publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id)));
});

app.get("/api/dashboard/student", auth, (req, res) => {
  const uid = req.user.id;
  const available = db
    .prepare(`SELECT COUNT(*) AS c FROM equipment WHERE status IN ('Available','Partially Available')`)
    .get().c;
  const active = db
    .prepare(`SELECT COUNT(*) AS c FROM bookings WHERE user_id=? AND status IN ('Approved','Active')`)
    .get(uid).c;
  const upcoming = db
    .prepare(
      `SELECT COUNT(*) AS c FROM bookings WHERE user_id=? AND status IN ('Pending','Approved') AND booking_date >= date('now')`
    )
    .get(uid).c;
  const pending = db
    .prepare(`SELECT COUNT(*) AS c FROM bookings WHERE user_id=? AND status='Pending'`).get(uid).c;
  const recent = db
    .prepare(`SELECT * FROM bookings WHERE user_id=? ORDER BY id DESC LIMIT 6`)
    .all(uid)
    .map(bookingPayload);
  res.json({ available, active, upcoming, pending, recent });
});

app.get("/api/dashboard/admin", auth, adminOnly, (_req, res) => {
  const count = (sql) => db.prepare(sql).get().c;
  res.json({
    users: count("SELECT COUNT(*) AS c FROM users"),
    equipment: count("SELECT COUNT(*) AS c FROM equipment"),
    available: count(`SELECT COUNT(*) AS c FROM equipment WHERE status IN ('Available','Partially Available')`),
    issued: count(`SELECT COUNT(*) AS c FROM equipment WHERE status='Issued'`),
    maintenance: count(`SELECT COUNT(*) AS c FROM equipment WHERE status IN ('Maintenance','Damaged')`),
    today: count(`SELECT COUNT(*) AS c FROM bookings WHERE booking_date = date('now')`),
    pending: count(`SELECT COUNT(*) AS c FROM bookings WHERE status='Pending'`),
    active: count(`SELECT COUNT(*) AS c FROM bookings WHERE status IN ('Approved','Active')`),
  });
});

app.get("/api/analytics", auth, adminOnly, (req, res) => {
  const from = req.query.from || "2000-01-01";
  const to = req.query.to || "2099-12-31";
  const sports = db
    .prepare(
      `SELECT s.name, COUNT(b.id) AS value FROM sports s
       LEFT JOIN bookings b ON b.sport_id = s.id AND b.booking_date BETWEEN ? AND ?
       GROUP BY s.id ORDER BY value DESC`
    )
    .all(from, to);
  const equipment = db
    .prepare(
      `SELECT e.name || ' ' || e.equipment_code AS name, COUNT(b.id) AS value
       FROM equipment e LEFT JOIN bookings b ON b.equipment_id = e.id AND b.booking_date BETWEEN ? AND ?
       GROUP BY e.id ORDER BY value DESC LIMIT 12`
    )
    .all(from, to);
  const daily = db
    .prepare(
      `SELECT booking_date AS date, COUNT(*) AS value FROM bookings
       WHERE booking_date BETWEEN ? AND ? GROUP BY booking_date ORDER BY booking_date`
    )
    .all(from, to);
  const hours = db
    .prepare(
      `SELECT substr(start_time,1,2) AS hour, COUNT(*) AS value FROM bookings
       WHERE booking_date BETWEEN ? AND ? GROUP BY hour ORDER BY hour`
    )
    .all(from, to);
  const status = db
    .prepare(`SELECT status AS name, COUNT(*) AS value FROM equipment GROUP BY status`)
    .all();
  const monthly = db
    .prepare(
      `SELECT substr(booking_date,1,7) AS month, COUNT(*) AS value FROM bookings
       WHERE booking_date BETWEEN ? AND ? GROUP BY month ORDER BY month`
    )
    .all(from, to);
  const damaged = db.prepare(`SELECT * FROM equipment WHERE status='Damaged'`).all();
  const lost = db.prepare(`SELECT * FROM equipment WHERE status='Lost'`).all();
  res.json({ sports, equipment, daily, hours, status, monthly, damaged, lost });
});

app.get("/api/search", auth, (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json({ equipment: [], sports: [], users: [], bookings: [] });
  const like = `%${q}%`;
  const equipment = db
    .prepare(
      `SELECT e.*, s.name AS sport_name FROM equipment e JOIN sports s ON s.id=e.sport_id
       WHERE e.name LIKE ? OR e.equipment_code LIKE ? LIMIT 8`
    )
    .all(like, like);
  const sports = db.prepare(`SELECT * FROM sports WHERE name LIKE ? LIMIT 6`).all(like);
  const bookings = db
    .prepare(`SELECT * FROM bookings WHERE booking_code LIKE ? LIMIT 6`)
    .all(like)
    .map(bookingPayload);
  let users = [];
  if (req.user.role === "admin") {
    users = db
      .prepare(`SELECT * FROM users WHERE full_name LIKE ? OR email LIKE ? OR student_id LIKE ? LIMIT 6`)
      .all(like, like, like)
      .map(publicUser);
  }
  res.json({ equipment, sports, users, bookings });
});

app.get("/api/settings", auth, adminOnly, (_req, res) => {
  const rows = db.prepare("SELECT * FROM settings").all();
  res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
});

app.put("/api/settings", auth, adminOnly, (req, res) => {
  const entries = Object.entries(req.body || {});
  const upsert = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  );
  const tx = db.transaction(() => {
    for (const [k, v] of entries) upsert.run(k, String(v));
  });
  tx();
  const rows = db.prepare("SELECT * FROM settings").all();
  res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "SportEase Backend API",
    version: "1.0.0"
  });
});

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "healthy", timestamp: new Date().toISOString() });
});

if (process.env.NODE_ENV === "production") {
  const dist = path.join(__dirname, "..", "dist");
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));
  }
}

const HOST = "0.0.0.0";
app.listen(PORT, HOST, () => {
  console.log(`SportEase API on http://${HOST}:${PORT}`);
  console.log(`Smart locker endpoint: POST http://<this-computer-ip>:${PORT}/api/device/tap (header X-Device-Key)`);
  if (DEVICE_KEY === DEFAULT_DEVICE_KEY) console.warn("WARNING: using the default DEVICE_KEY. Set DEVICE_KEY in .env before real use.");
});
