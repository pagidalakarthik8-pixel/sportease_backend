/*
 * SportEase smart locker reader  (ESP32 + RC522 + relay-driven latch)
 *
 * What it does
 *   1. Student taps their RFID ID card on the RC522.
 *   2. The ESP32 sends the card UID to the SportEase server over Wi-Fi
 *        POST /api/device/tap   (header X-Device-Key)
 *   3. The server decides: issue the booking that is due, or return the item held.
 *   4. If the reply says unlock:true, the relay opens the locker latch for a few seconds.
 *   5. If anything fails (no Wi-Fi, server down, card refused) the latch stays LOCKED
 *      and the red LED tells the student to use the manual counter (Module 5 fallback).
 *
 * STATUS: written for the Module 5 "next iteration". NOT yet bench-tested on real
 * hardware. Follow hardware/README.md (wiring + bench test) before relying on it.
 *
 * Arduino IDE setup
 *   Board : "ESP32 Dev Module"  (Boards Manager -> "esp32" by Espressif)
 *   Libraries (Library Manager): "MFRC522" by GithubCommunity/miguelbalboa, "ArduinoJson" 7.x
 *   Serial Monitor: 115200 baud
 */
#include <WiFi.h>
#include <HTTPClient.h>
#include <SPI.h>
#include <MFRC522.h>
#include <ArduinoJson.h>

// ===================== EDIT THESE =====================
const char* WIFI_SSID   = "YOUR_WIFI_NAME";
const char* WIFI_PASS   = "YOUR_WIFI_PASSWORD";
// IP address of the computer running SportEase (run `ipconfig` on Windows). No trailing slash.
const char* SERVER_URL  = "http://192.168.1.50:5174";
// Must match DEVICE_KEY in server/.env
const char* DEVICE_KEY  = "change-this-to-a-long-random-string";
const char* DEVICE_ID   = "locker-1";
// ======================================================

// ---- Pins (see hardware/README.md and wiring-diagram.svg) ----
const uint8_t PIN_RC522_SS   = 5;    // SDA
const uint8_t PIN_RC522_RST  = 22;
const uint8_t PIN_SPI_SCK    = 18;
const uint8_t PIN_SPI_MISO   = 19;
const uint8_t PIN_SPI_MOSI   = 23;
const uint8_t PIN_RELAY      = 26;
const uint8_t PIN_LED_GREEN  = 25;
const uint8_t PIN_LED_RED    = 27;
const uint8_t PIN_BUZZER     = 33;

const bool     RELAY_ACTIVE_LOW   = true;   // most 1-channel relay modules switch ON with a LOW signal
const uint32_t UNLOCK_MS          = 5000;   // how long the latch stays open
const uint32_t SAME_CARD_GAP_MS   = 3000;   // ignore the same card held on the reader
const uint32_t HTTP_TIMEOUT_MS    = 4000;   // server must answer within 4 s, otherwise "use counter"
const uint32_t WIFI_RETRY_MS      = 5000;

MFRC522 reader(PIN_RC522_SS, PIN_RC522_RST);

bool     latchOpen    = false;
uint32_t latchCloseAt = 0;
String   lastUid      = "";
uint32_t lastUidAt    = 0;
uint32_t lastWifiTry  = 0;

// ---- bench-test statistics (printed every 10 taps) ----
uint32_t statTaps = 0, statServerReplied = 0, statUnlocked = 0, statErrors = 0;
uint64_t statLatencySumMs = 0;

// ------------------------------------------------------------
void relayWrite(bool energise) {
  digitalWrite(PIN_RELAY, (energise ^ RELAY_ACTIVE_LOW) ? HIGH : LOW);
}

void openLatch() {
  relayWrite(true);
  latchOpen = true;
  latchCloseAt = millis() + UNLOCK_MS;
}

void closeLatch() {
  relayWrite(false);
  latchOpen = false;
}

void beep(uint16_t ms) {
  digitalWrite(PIN_BUZZER, HIGH);
  delay(ms);
  digitalWrite(PIN_BUZZER, LOW);
}

// success: green LED + one beep
void signalOk() {
  digitalWrite(PIN_LED_GREEN, HIGH);
  beep(120);
  delay(600);
  digitalWrite(PIN_LED_GREEN, LOW);
}

// refused / failed: red LED blinks 3 times + 3 short beeps  => "use the counter"
void signalDenied() {
  for (int i = 0; i < 3; i++) {
    digitalWrite(PIN_LED_RED, HIGH);
    beep(80);
    digitalWrite(PIN_LED_RED, LOW);
    delay(120);
  }
}

// ------------------------------------------------------------
void connectWifi(uint32_t waitMs) {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Connecting to Wi-Fi");
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < waitMs) {
    delay(300);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\nWi-Fi OK. IP %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\nWi-Fi not connected yet (will keep retrying).");
  }
}

// Calls GET /api/device/ping once at start-up: proves Wi-Fi + server + device key.
void pingServer() {
  if (WiFi.status() != WL_CONNECTED) return;
  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.begin(String(SERVER_URL) + "/api/device/ping");
  http.addHeader("X-Device-Key", DEVICE_KEY);
  int code = http.GET();
  Serial.printf("Server ping: HTTP %d %s\n", code,
                code == 200 ? "(server and device key OK)" :
                code == 401 ? "(device key does not match server/.env)" : "(cannot reach server)");
  http.end();
}

String uidToString(const MFRC522::Uid& uid) {
  String s;
  for (byte i = 0; i < uid.size; i++) {
    if (uid.uidByte[i] < 0x10) s += "0";
    s += String(uid.uidByte[i], HEX);
  }
  s.toUpperCase();
  return s;   // e.g. "04A3B2C1"
}

void printStats() {
  Serial.printf("STATS taps=%lu server_replied=%lu unlocked=%lu errors=%lu mean_latency_ms=%lu\n",
                (unsigned long)statTaps, (unsigned long)statServerReplied, (unsigned long)statUnlocked,
                (unsigned long)statErrors,
                (unsigned long)(statServerReplied ? statLatencySumMs / statServerReplied : 0));
}

// Sends the card to the server. Returns true if the latch should open.
bool sendTap(const String& uid) {
  statTaps++;
  if (WiFi.status() != WL_CONNECTED) {
    Serial.printf("TAP,%lu,%s,no_wifi,0,none,0\n", (unsigned long)millis(), uid.c_str());
    statErrors++;
    return false;
  }

  JsonDocument body;
  body["card_uid"]  = uid;
  body["device_id"] = DEVICE_ID;
  String payload;
  serializeJson(body, payload);

  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.begin(String(SERVER_URL) + "/api/device/tap");
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Key", DEVICE_KEY);

  uint32_t t0 = millis();
  int code = http.POST(payload);
  uint32_t latency = millis() - t0;

  if (code <= 0) {                       // network error / timeout
    Serial.printf("TAP,%lu,%s,%d,%lu,none,0\n", (unsigned long)millis(), uid.c_str(), code, (unsigned long)latency);
    statErrors++;
    http.end();
    return false;
  }

  String reply = http.getString();
  http.end();
  statServerReplied++;
  statLatencySumMs += latency;

  JsonDocument doc;
  if (deserializeJson(doc, reply)) {     // reply was not JSON
    Serial.printf("TAP,%lu,%s,%d,%lu,bad_json,0\n", (unsigned long)millis(), uid.c_str(), code, (unsigned long)latency);
    statErrors++;
    return false;
  }

  String action = doc["action"] | "none";
  bool   unlock = doc["unlock"] | false;
  String msg    = doc["message"] | "";
  if (msg.length() == 0) msg = doc["error"] | "";

  // CSV line used for the Module 5 bench test: millis,uid,http,latency_ms,action,unlock
  Serial.printf("TAP,%lu,%s,%d,%lu,%s,%d\n", (unsigned long)millis(), uid.c_str(), code, (unsigned long)latency,
                action.c_str(), unlock ? 1 : 0);
  Serial.printf("     server says: %s\n", msg.c_str());
  if (unlock) statUnlocked++;
  return code == 200 && unlock;
}

// ------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\nSportEase smart locker reader starting");

  pinMode(PIN_RELAY, OUTPUT);
  pinMode(PIN_LED_GREEN, OUTPUT);
  pinMode(PIN_LED_RED, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  closeLatch();                          // fail-secure: latch locked at power-up
  digitalWrite(PIN_LED_GREEN, LOW);
  digitalWrite(PIN_LED_RED, LOW);
  digitalWrite(PIN_BUZZER, LOW);

  SPI.begin(PIN_SPI_SCK, PIN_SPI_MISO, PIN_SPI_MOSI, PIN_RC522_SS);
  reader.PCD_Init();
  delay(50);
  byte version = reader.PCD_ReadRegister(MFRC522::VersionReg);
  Serial.printf("RC522 firmware version register: 0x%02X ", version);
  if (version == 0x00 || version == 0xFF) {
    Serial.println("-> NO COMMUNICATION. Check the 7 RC522 wires and use 3.3 V (never 5 V).");
    for (int i = 0; i < 5; i++) { digitalWrite(PIN_LED_RED, HIGH); delay(150); digitalWrite(PIN_LED_RED, LOW); delay(150); }
  } else {
    Serial.println("-> reader found.");
  }

  connectWifi(15000);
  pingServer();
  Serial.println("TAP,millis,uid,http,latency_ms,action,unlock   <- CSV columns for the bench test");
  Serial.println("Ready. Tap a card.");
}

void loop() {
  // keep the latch timing and Wi-Fi alive without blocking
  if (latchOpen && (int32_t)(millis() - latchCloseAt) >= 0) closeLatch();
  if (WiFi.status() != WL_CONNECTED && millis() - lastWifiTry > WIFI_RETRY_MS) {
    lastWifiTry = millis();
    Serial.println("Wi-Fi lost, reconnecting...");
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASS);
  }

  if (!reader.PICC_IsNewCardPresent() || !reader.PICC_ReadCardSerial()) return;

  String uid = uidToString(reader.uid);
  reader.PICC_HaltA();
  reader.PCD_StopCrypto1();

  // ignore the same card still resting on the reader
  if (uid == lastUid && millis() - lastUidAt < SAME_CARD_GAP_MS) return;
  lastUid = uid;
  lastUidAt = millis();

  bool unlock = sendTap(uid);
  if (unlock) {
    openLatch();
    signalOk();
  } else {
    signalDenied();                      // latch stays locked -> student uses the manual counter
  }
  if (statTaps % 10 == 0) printStats();
}
