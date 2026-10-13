// RFID logic: resolving tags, issuing and returning equipment.
// Kept separate from index.js so the rules live in one place.
const { notify, now, normalizeTag } = require("./db");

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function logScan(db, { tag, tag_type = "unknown", action, result, message = "", booking_id = null, equipment_id = null, admin_id = null }) {
  db.prepare(
    `INSERT INTO rfid_logs (tag, tag_type, action, result, message, booking_id, equipment_id, admin_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(tag, tag_type, action, result, message, booking_id, equipment_id, admin_id, now());
}

function openTransactionForEquipment(db, equipmentId) {
  return db
    .prepare(
      `SELECT * FROM equipment_transactions WHERE equipment_id = ? AND transaction_status = 'Issued' ORDER BY id DESC LIMIT 1`
    )
    .get(equipmentId);
}

// Look a tag up in both tables. Returns { tag, type, booking?, equipment?, openTransaction? }
function resolveTag(db, raw) {
  const tag = normalizeTag(raw);
  if (!tag) throw new HttpError(400, "No RFID tag received. Tap a card or type the tag.");
  const equipment = db.prepare("SELECT * FROM equipment WHERE rfid_tag = ?").get(tag);
  if (equipment) {
    return { tag, type: "equipment", equipment, openTransaction: openTransactionForEquipment(db, equipment.id) || null };
  }
  const booking = db.prepare("SELECT * FROM bookings WHERE rfid_tag = ?").get(tag);
  if (booking) return { tag, type: "booking", booking };
  return { tag, type: "unknown" };
}

// Shared by the RFID desk and the manual "Issue Equipment" button.
function issueBooking(db, booking, adminId) {
  if (!booking || !booking.equipment_id) throw new HttpError(400, "This booking has no equipment to issue (ground bookings need no issue).");
  if (!["Pending", "Approved", "Active"].includes(booking.status)) {
    throw new HttpError(400, `This booking is ${booking.status} and cannot be issued.`);
  }
  const open = db
    .prepare(`SELECT id FROM equipment_transactions WHERE booking_id = ? AND transaction_status = 'Issued'`)
    .get(booking.id);
  if (open) throw new HttpError(400, "This booking is already issued.");
  const eq = db.prepare("SELECT * FROM equipment WHERE id = ?").get(booking.equipment_id);
  if (!eq) throw new HttpError(400, "Equipment no longer exists.");
  if (["Maintenance", "Damaged", "Lost"].includes(eq.status)) {
    throw new HttpError(400, `${eq.name} ${eq.equipment_code} is marked ${eq.status} and cannot be issued.`);
  }
  if (openTransactionForEquipment(db, eq.id)) {
    throw new HttpError(400, `${eq.name} ${eq.equipment_code} is already issued to someone else.`);
  }
  const expected = `${booking.booking_date}T${booking.end_time}:00.000Z`;
  const info = db
    .prepare(
      `INSERT INTO equipment_transactions (booking_id, equipment_id, issued_to, issued_by, issued_at, expected_return_at, condition_before, remarks, transaction_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Issued')`
    )
    .run(booking.id, eq.id, booking.user_id, adminId, now(), expected, eq.condition, "Issued at desk");
  db.prepare(
    `UPDATE equipment SET status = 'Issued', available_quantity = MAX(available_quantity - 1, 0), updated_at = ? WHERE id = ?`
  ).run(now(), eq.id);
  db.prepare(`UPDATE bookings SET status = 'Active', updated_at = ? WHERE id = ?`).run(now(), booking.id);
  notify(db, booking.user_id, "Equipment issued", `${eq.name} ${eq.equipment_code} was issued.`, "Equipment Issued", booking.id);
  return db.prepare("SELECT * FROM equipment_transactions WHERE id = ?").get(info.lastInsertRowid);
}

// RFID issue: booking tag + equipment tag must belong together.
function issueByTags(db, bookingTag, equipmentTag, adminId) {
  const b = resolveTag(db, bookingTag);
  const e = resolveTag(db, equipmentTag);
  if (b.type !== "booking") throw new HttpError(400, "The first tag is not a booking card.");
  if (e.type !== "equipment") throw new HttpError(400, "The second tag is not an equipment tag.");
  if (b.booking.equipment_id !== e.equipment.id) {
    const wanted = db.prepare("SELECT name, equipment_code FROM equipment WHERE id = ?").get(b.booking.equipment_id);
    throw new HttpError(
      400,
      `Wrong equipment. Booking ${b.booking.booking_code} is for ${wanted?.name || "another item"} ${wanted?.equipment_code || ""}, but you scanned ${e.equipment.name} ${e.equipment.equipment_code}.`
    );
  }
  return issueBooking(db, b.booking, adminId);
}

function closeTransaction(db, tx, actor, { condition_after = "Good", remarks = "" } = {}) {
  if (tx.transaction_status !== "Issued") throw new HttpError(400, "This item is already closed.");
  if (actor.role !== "admin" && tx.issued_to !== actor.id) throw new HttpError(403, "You do not have access to this area.");
  let txStatus = "Returned";
  let eqStatus = "Available";
  let avail = 1;
  if (condition_after === "Damaged") {
    txStatus = "Damaged";
    eqStatus = "Damaged";
    avail = 0;
  }
  if (condition_after === "Lost") {
    txStatus = "Lost";
    eqStatus = "Lost";
    avail = 0;
  }
  if (actor.role !== "admin" && (condition_after === "Damaged" || condition_after === "Lost")) {
    throw new HttpError(400, "Only staff can mark damaged or lost equipment.");
  }
  db.prepare(
    `UPDATE equipment_transactions SET returned_at=?, returned_by=?, condition_after=?, remarks=?, transaction_status=? WHERE id=?`
  ).run(now(), actor.id, condition_after, remarks || "", txStatus, tx.id);
  const current = db.prepare("SELECT condition FROM equipment WHERE id=?").get(tx.equipment_id).condition;
  const nextCondition =
    condition_after === "Excellent" || condition_after === "Good" ? condition_after : eqStatus === "Damaged" ? "Damaged" : current;
  db.prepare(`UPDATE equipment SET status=?, condition=?, available_quantity=?, updated_at=? WHERE id=?`).run(
    eqStatus,
    nextCondition,
    avail,
    now(),
    tx.equipment_id
  );
  if (tx.booking_id) {
    db.prepare(`UPDATE bookings SET status='Completed', updated_at=? WHERE id=?`).run(now(), tx.booking_id);
  }
  const eq = db.prepare("SELECT * FROM equipment WHERE id = ?").get(tx.equipment_id);
  notify(
    db,
    tx.issued_to,
    "Your equipment was successfully returned.",
    `${eq.name} ${eq.equipment_code} is checked in.`,
    "Equipment Returned",
    tx.booking_id
  );
  return db.prepare("SELECT * FROM equipment_transactions WHERE id = ?").get(tx.id);
}

function returnByTag(db, equipmentTag, actor, body) {
  const e = resolveTag(db, equipmentTag);
  if (e.type !== "equipment") throw new HttpError(400, "That tag is not an equipment tag.");
  if (!e.openTransaction) throw new HttpError(400, `${e.equipment.name} ${e.equipment.equipment_code} is not currently issued.`);
  return closeTransaction(db, e.openTransaction, actor, body);
}

// ---------------------------------------------------------------------------
// Self-service smart locker: ONE tap of the student's own RFID ID card.
// Used by the ESP32 + RC522 reader through POST /api/device/tap.
//   - If the student holds an issued item  -> the tap RETURNS it.
//   - Otherwise                            -> the tap ISSUES their booking that is due now.
// Anything unclear (no booking, several bookings, wrong time) is refused and the
// student falls back to the manual counter, exactly as planned in Module 5.
// ---------------------------------------------------------------------------
const EARLY_MINUTES = 15; // a student may collect up to 15 min before the booking starts

function localClock(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    minutes: d.getHours() * 60 + d.getMinutes(),
  };
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
}

function studentTap(db, rawTag, at = new Date()) {
  const tag = normalizeTag(rawTag);
  if (!tag) throw new HttpError(400, "No card UID received.");

  const finish = (out, logResult) => {
    logScan(db, {
      tag,
      tag_type: "student",
      action: out.action === "denied" ? "tap" : out.action,
      result: logResult || (out.ok ? "ok" : "denied"),
      message: out.message,
      booking_id: out.booking_id || null,
      equipment_id: out.equipment_id || null,
    });
    return { ...out, tag };
  };
  const deny = (message, logResult) => finish({ ok: false, action: "denied", unlock: false, message }, logResult);

  const user = db.prepare("SELECT * FROM users WHERE rfid_tag = ?").get(tag);
  if (!user) return deny("Card not registered. Please use the counter.", "unknown");
  if (user.account_status !== "active") return deny("Account inactive. Please use the counter.");

  // 1) Student already holds an item -> this tap is a RETURN
  const open = db
    .prepare(`SELECT * FROM equipment_transactions WHERE issued_to = ? AND transaction_status = 'Issued' ORDER BY id`)
    .all(user.id);
  if (open.length > 1) return deny("You hold more than one item. Please return them at the counter.");
  if (open.length === 1) {
    const tx = closeTransaction(db, open[0], { id: user.id, role: "student" }, {
      condition_after: "Good",
      remarks: "Returned at smart locker - pending staff inspection",
    });
    const eq = db.prepare("SELECT * FROM equipment WHERE id = ?").get(tx.equipment_id);
    return finish({
      ok: true,
      action: "return",
      unlock: true,
      message: `Returned ${eq.name} ${eq.equipment_code}. Thank you.`,
      student: user.full_name,
      user_id: user.id,
      booking_id: tx.booking_id,
      equipment_id: tx.equipment_id,
      transaction_id: tx.id,
    });
  }

  // 2) Otherwise -> ISSUE the booking that is due now
  const { date, minutes } = localClock(at);
  const rows = db
    .prepare(
      `SELECT * FROM bookings WHERE user_id = ? AND equipment_id IS NOT NULL AND status = 'Approved' AND booking_date = ? ORDER BY start_time`
    )
    .all(user.id, date);
  const due = rows.filter((b) => minutes >= toMinutes(b.start_time) - EARLY_MINUTES && minutes < toMinutes(b.end_time));
  if (due.length === 0) {
    const later = rows.find((b) => minutes < toMinutes(b.start_time) - EARLY_MINUTES);
    return deny(
      later
        ? `Your booking starts at ${later.start_time}. Please come back then.`
        : "No approved booking for this time. Book on the portal or use the counter."
    );
  }
  if (due.length > 1) return deny("You have more than one booking due now. Please use the counter.");

  try {
    const tx = issueBooking(db, due[0], user.id);
    const eq = db.prepare("SELECT * FROM equipment WHERE id = ?").get(tx.equipment_id);
    return finish({
      ok: true,
      action: "issue",
      unlock: true,
      message: `Collect ${eq.name} ${eq.equipment_code}.`,
      student: user.full_name,
      user_id: user.id,
      booking_id: due[0].id,
      equipment_id: eq.id,
      transaction_id: tx.id,
    });
  } catch (e) {
    if (e instanceof HttpError) return deny(e.message);
    throw e;
  }
}

module.exports = { HttpError, logScan, resolveTag, issueBooking, issueByTags, closeTransaction, returnByTag, studentTap, localClock };
