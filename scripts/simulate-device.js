// Pretends to be the ESP32 + RC522 reader, so you can demo the smart locker with NO hardware.
//
//   node scripts/simulate-device.js <CARD_UID> [server_url]
//
// Example:  node scripts/simulate-device.js ST-1A2B3C4D
//           (find a student's card in Admin -> Users, column "RFID card")
//
// The server must be running. The device key is read from DEVICE_KEY (env) or the demo default.
const uid = process.argv[2];
const base = process.argv[3] || "http://127.0.0.1:5174";
const key = process.env.DEVICE_KEY || "sportease-device-demo-key";

if (!uid) {
  console.log("Usage: node scripts/simulate-device.js <CARD_UID> [server_url]");
  process.exit(1);
}

(async () => {
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/api/device/tap`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Device-Key": key },
      body: JSON.stringify({ card_uid: uid, device_id: "simulator" }),
    });
    const data = await res.json();
    console.log(`HTTP ${res.status}  (${Date.now() - t0} ms)`);
    console.log(data);
    console.log(data.unlock ? ">>> LATCH OPENS (relay ON for 5 s)" : ">>> LATCH STAYS LOCKED - use the manual counter");
  } catch (e) {
    console.error("Could not reach the server:", e.message);
    process.exit(1);
  }
})();
