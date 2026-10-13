// Booking messages to students: WhatsApp, SMS and email.
//
// Two modes:
//  1. Automatic  - set Twilio credentials in server/.env and WhatsApp/SMS are sent by the server.
//  2. Click-to-send (default, no setup) - every message is saved in message_log and the admin
//     opens WhatsApp / SMS / Email with the text pre-filled and presses send.
const { now } = require("./db");

function intlPhone(phone) {
  const cc = process.env.DEFAULT_COUNTRY_CODE || "91";
  let d = String(phone || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0") && d.length === 11) d = d.slice(1);
  if (d.length === 10) d = cc + d;
  return d.length >= 11 ? d : "";
}

function providerStatus() {
  const base = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
  return {
    whatsapp_auto: base && !!process.env.TWILIO_WHATSAPP_FROM,
    sms_auto: base && !!process.env.TWILIO_SMS_FROM,
    admin_alert_phone: !!intlPhone(process.env.ADMIN_PHONE),
  };
}

const EVENT_TITLE = {
  created: "Booking received",
  approved: "Booking confirmed",
  rejected: "Booking rejected",
  cancelled: "Booking cancelled",
  issued: "Equipment issued",
  returned: "Equipment returned",
  reminder: "Reminder",
  custom: "Booking update",
};

// `b` is the object returned by bookingPayload() in index.js
function bookingMessage(b, event = "custom", extra = "") {
  const item = b.equipment ? `${b.equipment.name} (${b.equipment.equipment_code})` : b.ground?.name || "Ground booking";
  const lines = [
    `SportEase - ${EVENT_TITLE[event] || EVENT_TITLE.custom}`,
    `Hi ${b.user?.full_name?.split(" ")[0] || "there"},`,
    `Booking: ${b.booking_code}`,
    `Item: ${item}`,
    `Date: ${b.booking_date}`,
    `Time: ${b.start_time} - ${b.end_time}`,
    `Status: ${b.status}`,
    b.rfid_tag ? `Your booking RFID: ${b.rfid_tag}` : "",
    extra,
    ["created", "approved"].includes(event) ? "Show your RFID card / QR pass at the sports desk to collect your equipment." : "",
  ];
  return lines.filter(Boolean).join("\n");
}

function links(phone, email, text) {
  const n = intlPhone(phone);
  const q = encodeURIComponent(text);
  return {
    whatsapp: n ? `https://wa.me/${n}?text=${q}` : null,
    sms: n ? `sms:+${n}?body=${q}` : null,
    email: email ? `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent("SportEase booking update")}&body=${q}` : null,
  };
}

async function sendViaTwilio(channel, phone, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const n = intlPhone(phone);
  if (!n) throw new Error("Student has no valid phone number.");
  const prefix = (v) => (String(v).startsWith("whatsapp:") ? v : `whatsapp:${String(v).startsWith("+") ? v : "+" + v}`);
  const from = channel === "whatsapp" ? prefix(process.env.TWILIO_WHATSAPP_FROM) : process.env.TWILIO_SMS_FROM;
  const to = channel === "whatsapp" ? `whatsapp:+${n}` : `+${n}`;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Twilio HTTP ${res.status}`);
  return data.sid;
}

// Save a message and, when a provider is configured, send it in the background.
// Never throws: a failed WhatsApp must not break a booking.
function queueMessage(db, { userId = null, bookingId = null, channel = "whatsapp", event = "custom", phone, email, body, createdBy = null }) {
  const status = providerStatus();
  const canAuto = (channel === "whatsapp" && status.whatsapp_auto) || (channel === "sms" && status.sms_auto);
  const hasPhone = !!intlPhone(phone);
  let state = "manual"; // waiting for admin to press send
  if (channel !== "email" && !hasPhone) state = "no_phone";
  else if (channel === "email" && !email) state = "no_email";
  else if (canAuto) state = "queued";
  const info = db
    .prepare(
      `INSERT INTO message_log (user_id, booking_id, channel, event, to_phone, body, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(userId, bookingId, channel, event, intlPhone(phone) || null, body, state, createdBy, now());
  const id = info.lastInsertRowid;
  if (state === "queued") {
    sendViaTwilio(channel, phone, body)
      .then((ref) => db.prepare("UPDATE message_log SET status='sent', provider_ref=? WHERE id=?").run(ref, id))
      .catch((err) => {
        console.error("[messaging] send failed:", err.message);
        db.prepare("UPDATE message_log SET status='failed', error=? WHERE id=?").run(String(err.message).slice(0, 300), id);
      });
  }
  return db.prepare("SELECT * FROM message_log WHERE id = ?").get(id);
}

// Event hook used by the booking routes: message the student (and the admin alert phone, if set).
function dispatchBookingEvent(db, b, event, { extra = "", createdBy = null, alertAdmin = false } = {}) {
  try {
    const body = bookingMessage(b, event, extra);
    const row = queueMessage(db, {
      userId: b.user_id,
      bookingId: b.id,
      channel: "whatsapp",
      event,
      phone: b.user?.phone,
      email: b.user?.email,
      body,
      createdBy,
    });
    if (alertAdmin && providerStatus().admin_alert_phone) {
      queueMessage(db, {
        bookingId: b.id,
        channel: "whatsapp",
        event: "admin_alert",
        phone: process.env.ADMIN_PHONE,
        body: `ADMIN ALERT\n${b.user?.full_name} (${b.user?.student_id}) made booking ${b.booking_code}.\n` + body.split("\n").slice(3).join("\n"),
      });
    }
    return row;
  } catch (err) {
    console.error("[messaging] dispatch failed:", err.message);
    return null;
  }
}

module.exports = { intlPhone, providerStatus, bookingMessage, links, queueMessage, dispatchBookingEvent };
