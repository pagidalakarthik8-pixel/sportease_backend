const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const bcrypt = require("bcryptjs");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "sportease.db");

function now() {
  return new Date().toISOString();
}

function connect() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const raw = new DatabaseSync(DB_PATH);
  raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("PRAGMA foreign_keys = ON");
  const origPrepare = raw.prepare.bind(raw);
  raw.prepare = (sql) => {
    const stmt = origPrepare(sql);
    const origRun = stmt.run.bind(stmt);
    stmt.run = (...args) => {
      const result = origRun(...args);
      if (result && result.lastInsertRowid != null) {
        result.lastInsertRowid = Number(result.lastInsertRowid);
      }
      return result;
    };
    return stmt;
  };
  raw.transaction = (fn) => () => {
    raw.exec("BEGIN");
    try {
      const out = fn();
      raw.exec("COMMIT");
      return out;
    } catch (err) {
      try {
        raw.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw err;
    }
  };
  return raw;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      student_id TEXT UNIQUE,
      phone TEXT,
      profile_image TEXT,
      department TEXT,
      year TEXT,
      role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student','admin')),
      account_status TEXT NOT NULL DEFAULT 'active' CHECK (account_status IN ('active','inactive')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      icon TEXT,
      image TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS equipment_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sport_id INTEGER NOT NULL REFERENCES sports(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS equipment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER REFERENCES equipment_categories(id) ON DELETE SET NULL,
      sport_id INTEGER NOT NULL REFERENCES sports(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      equipment_code TEXT NOT NULL UNIQUE,
      serial_number TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      available_quantity INTEGER NOT NULL DEFAULT 1,
      condition TEXT NOT NULL DEFAULT 'Good',
      status TEXT NOT NULL DEFAULT 'Available',
      image TEXT,
      description TEXT,
      purchase_date TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS grounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sport_id INTEGER NOT NULL REFERENCES sports(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      location TEXT,
      capacity INTEGER,
      description TEXT,
      image TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      opening_time TEXT NOT NULL DEFAULT '07:00',
      closing_time TEXT NOT NULL DEFAULT '20:00',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS time_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_code TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      equipment_id INTEGER REFERENCES equipment(id),
      ground_id INTEGER REFERENCES grounds(id),
      sport_id INTEGER NOT NULL REFERENCES sports(id),
      booking_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      purpose TEXT,
      status TEXT NOT NULL DEFAULT 'Pending',
      admin_notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      rfid_tag TEXT
    );

    CREATE TABLE IF NOT EXISTS equipment_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id INTEGER REFERENCES bookings(id),
      equipment_id INTEGER NOT NULL REFERENCES equipment(id),
      issued_to INTEGER NOT NULL REFERENCES users(id),
      issued_by INTEGER NOT NULL REFERENCES users(id),
      issued_at TEXT NOT NULL,
      expected_return_at TEXT,
      returned_at TEXT,
      returned_by INTEGER REFERENCES users(id),
      condition_before TEXT,
      condition_after TEXT,
      remarks TEXT,
      transaction_status TEXT NOT NULL DEFAULT 'Issued'
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'System',
      related_booking_id INTEGER,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  // --- RFID: one unique tag per equipment item and one per booking ---
  ensureColumn(db, "equipment", "rfid_tag", "TEXT");
  ensureColumn(db, "bookings", "rfid_tag", "TEXT");
  // The student's own RFID ID card (read by the ESP32 + RC522 reader at the smart locker)
  ensureColumn(db, "users", "rfid_tag", "TEXT");
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_rfid ON users(rfid_tag);`);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_equipment_rfid ON equipment(rfid_tag);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_rfid ON bookings(rfid_tag);

    CREATE TABLE IF NOT EXISTS rfid_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tag TEXT NOT NULL,
      tag_type TEXT NOT NULL,
      action TEXT NOT NULL,
      result TEXT NOT NULL,
      message TEXT,
      booking_id INTEGER,
      equipment_id INTEGER,
      admin_id INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS message_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      booking_id INTEGER,
      channel TEXT NOT NULL DEFAULT 'whatsapp',
      event TEXT NOT NULL DEFAULT 'custom',
      to_phone TEXT,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'manual',
      provider_ref TEXT,
      error TEXT,
      created_by INTEGER,
      created_at TEXT NOT NULL
    );
  `);
  // Payment feature was removed: drop the old fee settings if they exist.
  db.prepare(`DELETE FROM settings WHERE key IN ('equipment_fee','ground_fee')`).run();
}

function ensureColumn(db, table, column, spec) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${spec}`);
  }
}

function notify(db, userId, title, message, type, relatedBookingId = null) {
  db.prepare(
    `INSERT INTO notifications (user_id, title, message, type, related_booking_id, is_read, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`
  ).run(userId, title, message, type, relatedBookingId, now());
}

function nextBookingCode(db) {
  const year = new Date().getFullYear();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM bookings WHERE booking_code LIKE ?`
    )
    .get(`SPT-${year}-%`);
  return `SPT-${year}-${String((row?.c || 0) + 1).padStart(5, "0")}`;
}

function seed(db) {
  const count = db.prepare("SELECT COUNT(*) AS c FROM users").get().c;
  if (count > 0) return;

  const ts = now();
  const hash = (pw) => bcrypt.hashSync(pw, 10);

  const insertUser = db.prepare(`
    INSERT INTO users (full_name, email, password_hash, student_id, phone, department, year, role, account_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `);

  const students = [
    ["Alex Rivera", "student@sportease.com", "STU-1001", "Computer Science", "3"],
    ["Priya Sharma", "priya@sportease.com", "STU-1002", "Mechanical", "2"],
    ["Jordan Lee", "jordan@sportease.com", "STU-1003", "Business", "1"],
    ["Maya Chen", "maya@sportease.com", "STU-1004", "Sports Science", "4"],
    ["Omar Haddad", "omar@sportease.com", "STU-1005", "Electrical", "3"],
    ["Sofia Alvarez", "sofia@sportease.com", "STU-1006", "Computer Science", "2"],
    ["Noah Patel", "noah@sportease.com", "STU-1007", "Civil", "1"],
    ["Aisha Khan", "aisha@sportease.com", "STU-1008", "Sports Science", "3"],
    ["Liam Brooks", "liam@sportease.com", "STU-1009", "Arts", "2"],
    ["Hana Kim", "hana@sportease.com", "STU-1010", "Computer Science", "4"],
  ];

  insertUser.run(
    "Campus Sports Manager",
    "admin@sportease.com",
    hash("admin123"),
    "ADM-0001",
    "+1 555 0100",
    "Athletics",
    "Staff",
    "admin",
    ts,
    ts
  );

  for (const [full_name, email, student_id, department, year] of students) {
    insertUser.run(
      full_name,
      email,
      hash("student123"),
      student_id,
      "+1 555 01" + student_id.slice(-2),
      department,
      year,
      "student",
      ts,
      ts
    );
  }

  const sports = [
    ["Cricket", "Bats, pads, and turf-ready kit for campus cricket.", "🏏", "https://images.unsplash.com/photo-1531415074968-036d9b722b5a?w=1200&q=80"],
    ["Football", "Match balls, nets, and training kit for football.", "⚽", "https://images.unsplash.com/photo-1579952363873-27f3bade9f55?w=1200&q=80"],
    ["Basketball", "Indoor court kit for pickup games and leagues.", "🏀", "https://images.unsplash.com/photo-1546519638-68e109498ffc?w=1200&q=80"],
    ["Volleyball", "Nets, balls, and pads for indoor and beach play.", "🏐", "https://images.unsplash.com/photo-1612872087720-bb876e2e67d1?w=1200&q=80"],
    ["Badminton", "Rackets, shuttles, and nets for indoor courts.", "🏸", "https://images.unsplash.com/photo-1626224583764-f87db24ac4ea?w=1200&q=80"],
    ["Table Tennis", "Bats, balls, and nets for the TT room.", "🏓", "https://images.unsplash.com/photo-1534158914592-062992fbe900?w=1200&q=80"],
  ];
  const insertSport = db.prepare(
    `INSERT INTO sports (name, description, icon, image, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)`
  );
  for (const s of sports) insertSport.run(...s, ts);

  const insertCat = db.prepare(
    `INSERT INTO equipment_categories (sport_id, name, description, created_at) VALUES (?, ?, ?, ?)`
  );
  const cats = [
    [1, "Batting", "Bats, pads, gloves"],
    [1, "Bowling", "Balls and bowling gloves"],
    [1, "Protection", "Helmets and guards"],
    [1, "Field", "Stumps, wickets, cones"],
    [2, "Match", "Football match kit"],
    [2, "Training", "Cones, bibs, nets"],
    [3, "Match", "Basketballs and nets"],
    [3, "Training", "Cones and jerseys"],
    [4, "Match", "Volleyballs and nets"],
    [4, "Protection", "Knee pads"],
    [5, "Rackets", "Badminton rackets"],
    [5, "Consumables", "Shuttlecocks and nets"],
    [6, "Bats", "Table tennis bats"],
    [6, "Table", "Balls and nets"],
  ];
  for (const c of cats) insertCat.run(...c, ts);

  const insertEq = db.prepare(`
    INSERT INTO equipment (category_id, sport_id, name, equipment_code, serial_number, quantity, available_quantity, condition, status, image, description, purchase_date, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?)
  `);

  const eq = [
    [1, 1, "Cricket Bat", "CB-001", "Excellent", "Available"],
    [1, 1, "Cricket Bat", "CB-002", "Good", "Available"],
    [1, 1, "Cricket Bat", "CB-003", "Good", "Available"],
    [2, 1, "Cricket Ball", "CBL-001", "Good", "Available"],
    [2, 1, "Cricket Ball", "CBL-002", "Average", "Available"],
    [4, 1, "Wickets", "CW-001", "Good", "Available"],
    [1, 1, "Batting Gloves", "CG-001", "Excellent", "Available"],
    [1, 1, "Batting Gloves", "CG-002", "Good", "Available"],
    [2, 1, "Bowling Gloves", "BG-001", "Good", "Available"],
    [3, 1, "Helmet", "CH-001", "Excellent", "Available"],
    [1, 1, "Batting Pads", "BP-001", "Good", "Available"],
    [1, 1, "Batting Pads", "BP-002", "Average", "Available"],
    [3, 1, "Thigh Guard", "TG-001", "Good", "Available"],
    [4, 1, "Cricket Stumps", "CS-001", "Good", "Available"],
    [4, 1, "Cones", "CN-001", "Good", "Available"],
    [5, 2, "Football", "FB-001", "Excellent", "Available"],
    [5, 2, "Football", "FB-002", "Good", "Available"],
    [5, 2, "Football", "FB-003", "Good", "Available"],
    [6, 2, "Goal Net", "GN-001", "Good", "Available"],
    [6, 2, "Cones", "FC-001", "Good", "Available"],
    [5, 2, "Shin Guards", "SG-001", "Excellent", "Available"],
    [5, 2, "Shin Guards", "SG-002", "Good", "Available"],
    [5, 2, "Goalkeeper Gloves", "GG-001", "Good", "Available"],
    [6, 2, "Training Bibs", "TB-001", "Good", "Available"],
    [7, 3, "Basketball", "BB-001", "Excellent", "Available"],
    [7, 3, "Basketball", "BB-002", "Good", "Available"],
    [7, 3, "Basketball Net", "BN-001", "Good", "Available"],
    [8, 3, "Training Cones", "TC-001", "Good", "Available"],
    [8, 3, "Jerseys", "JR-001", "Good", "Available"],
    [9, 4, "Volleyball", "VB-001", "Excellent", "Available"],
    [9, 4, "Volleyball", "VB-002", "Good", "Available"],
    [9, 4, "Volleyball Net", "VN-001", "Good", "Available"],
    [10, 4, "Knee Pads", "KP-001", "Good", "Available"],
    [9, 4, "Training Cones", "VC-001", "Average", "Available"],
    [11, 5, "Badminton Racket", "BR-001", "Excellent", "Available"],
    [11, 5, "Badminton Racket", "BR-002", "Good", "Available"],
    [12, 5, "Shuttlecock", "SC-001", "Good", "Available"],
    [12, 5, "Shuttlecock", "SC-002", "Good", "Available"],
    [12, 5, "Badminton Net", "BDN-001", "Good", "Available"],
    [13, 6, "Table Tennis Bat", "TT-001", "Excellent", "Available"],
    [13, 6, "Table Tennis Bat", "TT-002", "Good", "Available"],
    [14, 6, "Table Tennis Balls", "TTB-001", "Good", "Available"],
    [14, 6, "Table Tennis Net", "TTN-001", "Good", "Available"],
  ];

  const images = {
    1: "https://images.unsplash.com/photo-1531415074968-036d9b722b5a?w=800&q=80",
    2: "https://images.unsplash.com/photo-1579952363873-27f3bade9f55?w=800&q=80",
    3: "https://images.unsplash.com/photo-1546519638-68e109498ffc?w=800&q=80",
    4: "https://images.unsplash.com/photo-1612872087720-bb876e2e67d1?w=800&q=80",
    5: "https://images.unsplash.com/photo-1626224583764-f87db24ac4ea?w=800&q=80",
    6: "https://images.unsplash.com/photo-1534158914592-062992fbe900?w=800&q=80",
  };

  for (const [category_id, sport_id, name, equipment_code, condition, status] of eq) {
    insertEq.run(
      category_id,
      sport_id,
      name,
      equipment_code,
      `SN-${equipment_code}`,
      condition,
      status,
      images[sport_id],
      `${name} (${equipment_code}) maintained by campus athletics.`,
      "2025-06-15",
      ts,
      ts
    );
  }

  db.prepare(`UPDATE equipment SET status = 'Maintenance', available_quantity = 0 WHERE equipment_code = 'BP-002'`).run();
  db.prepare(`UPDATE equipment SET status = 'Damaged', condition = 'Damaged', available_quantity = 0 WHERE equipment_code = 'VC-001'`).run();

  const insertGround = db.prepare(`
    INSERT INTO grounds (sport_id, name, location, capacity, description, image, status, opening_time, closing_time, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
  `);
  const grounds = [
    [1, "Main Cricket Ground", "East Campus Oval", 22, "Full-size turf with nets.", images[1], "07:00", "19:00"],
    [2, "Football Ground", "West Field", 22, "Floodlit 11-a-side pitch.", images[2], "07:00", "20:00"],
    [3, "Basketball Court 1", "Indoor Arena A", 10, "Maple indoor court.", images[3], "08:00", "21:00"],
    [4, "Volleyball Court 1", "Indoor Arena B", 12, "Competition-height net.", images[4], "08:00", "21:00"],
    [5, "Badminton Court 1", "Sports Hall 2", 4, "Wooden indoor court.", images[5], "08:00", "20:00"],
    [6, "Table Tennis Room", "Recreation Block", 8, "Two competition tables.", images[6], "09:00", "21:00"],
  ];
  for (const g of grounds) insertGround.run(...g, ts);

  const insertSlot = db.prepare(
    `INSERT INTO time_slots (label, start_time, end_time, active) VALUES (?, ?, ?, 1)`
  );
  const slots = [
    ["7:00 AM – 8:00 AM", "07:00", "08:00"],
    ["8:00 AM – 9:00 AM", "08:00", "09:00"],
    ["9:00 AM – 10:00 AM", "09:00", "10:00"],
    ["10:00 AM – 11:00 AM", "10:00", "11:00"],
    ["4:00 PM – 5:00 PM", "16:00", "17:00"],
    ["5:00 PM – 6:00 PM", "17:00", "18:00"],
    ["6:00 PM – 7:00 PM", "18:00", "19:00"],
    ["7:00 PM – 8:00 PM", "19:00", "20:00"],
  ];
  for (const s of slots) insertSlot.run(...s);

  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run("max_active_bookings", "3");
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run("max_duration_hours", "3");
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run("min_duration_minutes", "60");
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run("require_approval", "1");

  const insertBooking = db.prepare(`
    INSERT INTO bookings (booking_code, user_id, equipment_id, ground_id, sport_id, booking_date, start_time, end_time, purpose, status, admin_notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const today = new Date();
  const d = (offset) => {
    const x = new Date(today);
    x.setDate(x.getDate() + offset);
    return x.toISOString().slice(0, 10);
  };

  const samples = [
    [2, 1, null, 1, d(1), "16:00", "17:00", "Practice nets", "Pending", null],
    [3, 16, null, 2, d(1), "17:00", "18:00", "Evening match", "Approved", "Approved for team practice"],
    [4, 25, null, 3, d(0), "18:00", "19:00", "Pickup game", "Active", null],
    [5, 30, null, 4, d(-2), "16:00", "17:00", "Club session", "Completed", null],
    [6, 35, null, 5, d(2), "09:00", "10:00", "Singles practice", "Pending", null],
    [7, 40, null, 6, d(1), "10:00", "11:00", "Table tennis club", "Approved", null],
    [8, null, 1, 1, d(3), "07:00", "09:00", "Inter-dept cricket", "Pending", null],
    [9, null, 2, 2, d(2), "16:00", "18:00", "Football training", "Approved", null],
    [10, 2, null, 1, d(-1), "17:00", "18:00", "Net session", "Cancelled", "Student cancelled"],
    [11, 3, null, 1, d(0), "07:00", "08:00", "Morning nets", "Rejected", "Ground already reserved"],
    [2, 4, null, 1, d(4), "18:00", "19:00", "Bowling practice", "Pending", null],
    [3, 18, null, 2, d(-3), "16:00", "17:00", "Keeper drills", "Completed", null],
    [4, 26, null, 3, d(1), "19:00", "20:00", "3v3", "Approved", null],
    [5, null, 3, 3, d(2), "08:00", "10:00", "Basketball league", "Pending", null],
    [6, 31, null, 4, d(5), "18:00", "19:00", "Volleyball drill", "Pending", null],
    [7, 36, null, 5, d(-4), "16:00", "17:00", "Doubles", "Completed", null],
    [8, null, 5, 5, d(1), "16:00", "17:00", "Badminton club", "Active", null],
    [9, 41, null, 6, d(0), "09:00", "10:00", "TT warmup", "Approved", null],
    [10, 7, null, 1, d(6), "16:00", "17:00", "Gloves fitting", "Pending", null],
    [2, null, 6, 6, d(3), "10:00", "12:00", "Table tennis open", "Approved", null],
  ];

  samples.forEach((row, i) => {
    const [user_id, equipment_id, ground_id, sport_id, date, start, end, purpose, status, notes] = row;
    insertBooking.run(
      `SPT-${new Date().getFullYear()}-${String(i + 1).padStart(5, "0")}`,
      user_id,
      equipment_id,
      ground_id,
      sport_id,
      date,
      start,
      end,
      purpose,
      status,
      notes,
      ts,
      ts
    );
  });

  const insertTx = db.prepare(`
    INSERT INTO equipment_transactions (booking_id, equipment_id, issued_to, issued_by, issued_at, expected_return_at, returned_at, returned_by, condition_before, condition_after, remarks, transaction_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertTx.run(3, 25, 4, 1, ts, d(0) + "T19:00:00.000Z", null, null, "Excellent", null, "Issued at arena desk", "Issued");
  db.prepare(`UPDATE equipment SET status = 'Issued', available_quantity = 0 WHERE id = 25`).run();
  insertTx.run(4, 30, 5, 1, d(-2) + "T16:00:00.000Z", d(-2) + "T17:00:00.000Z", d(-2) + "T17:10:00.000Z", 1, "Excellent", "Good", "Returned on time", "Returned");

  notify(db, 2, "Welcome to SportEase", "Book equipment and grounds from your dashboard.", "System");
  notify(db, 3, "Your football booking was approved.", "FB-001 is ready for 5:00 PM – 6:00 PM.", "Booking Approved", 2);
  notify(db, 4, "Equipment issued", "Basketball BB-001 was issued. Show your QR when playing.", "Equipment Issued", 3);
  notify(db, 5, "Your equipment was successfully returned.", "Volleyball VB-001 has been checked in.", "Equipment Returned", 4);
  notify(db, 11, "Your booking was rejected.", "Morning nets overlapped with an existing reservation.", "Booking Rejected", 10);
}

// ---------- RFID helpers ----------
// Tags look like a 4-byte card UID in hex. Prefix makes demo data easy to read:
//   EQ-XXXXXXXX = equipment item, BK-XXXXXXXX = booking.
function normalizeTag(tag) {
  return String(tag || "")
    .trim()
    .toUpperCase()
    .replace(/[\s:]/g, "");
}

function tagInUse(db, tag, { exceptEquipmentId = null, exceptBookingId = null, exceptUserId = null } = {}) {
  const e = db.prepare("SELECT id FROM equipment WHERE rfid_tag = ?").get(tag);
  if (e && e.id !== Number(exceptEquipmentId)) return "equipment";
  const b = db.prepare("SELECT id FROM bookings WHERE rfid_tag = ?").get(tag);
  if (b && b.id !== Number(exceptBookingId)) return "booking";
  const u = db.prepare("SELECT id FROM users WHERE rfid_tag = ?").get(tag);
  if (u && u.id !== Number(exceptUserId)) return "student card";
  return null;
}

function generateTag(db, prefix) {
  for (let i = 0; i < 50; i++) {
    const tag = `${prefix}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
    if (!tagInUse(db, tag)) return tag;
  }
  throw new Error("Could not generate a unique RFID tag.");
}

function backfillRfid(db) {
  const eq = db.prepare("SELECT id FROM equipment WHERE rfid_tag IS NULL OR rfid_tag = ''").all();
  const bk = db.prepare("SELECT id FROM bookings WHERE rfid_tag IS NULL OR rfid_tag = ''").all();
  const setEq = db.prepare("UPDATE equipment SET rfid_tag = ? WHERE id = ?");
  const setBk = db.prepare("UPDATE bookings SET rfid_tag = ? WHERE id = ?");
  for (const r of eq) setEq.run(generateTag(db, "EQ"), r.id);
  for (const r of bk) setBk.run(generateTag(db, "BK"), r.id);
  // Every student gets a virtual card (ST-XXXXXXXX) so the demo works with no hardware.
  // Admin -> Users lets you replace it with the real card UID (e.g. 04A3B2C1).
  const st = db.prepare("SELECT id FROM users WHERE role = 'student' AND (rfid_tag IS NULL OR rfid_tag = '')").all();
  const setSt = db.prepare("UPDATE users SET rfid_tag = ? WHERE id = ?");
  for (const r of st) setSt.run(generateTag(db, "ST"), r.id);
}

function getDb() {
  const db = connect();
  migrate(db);
  seed(db);
  db.prepare(`UPDATE settings SET value = '0' WHERE key = 'require_approval'`).run();
  backfillRfid(db);
  return db;
}

function reset() {
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  getDb().close();
}

module.exports = { getDb, notify, nextBookingCode, now, reset, normalizeTag, tagInUse, generateTag };
