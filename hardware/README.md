# SportEase Smart Locker – Hardware (ESP32 + RC522 + latch)

This folder is the **circuit and firmware side** of the project from Modules 4 and 5:

```
Student ID card → RC522 reader → ESP32 (Wi-Fi) → SportEase server → relay → locker latch
```

> **Status: prototype plan. The firmware has not been compiled or bench-tested on real hardware yet.**
> The server side (`POST /api/device/tap`) is tested. Module 5 lists the bench test below as the next step.

| File | What it is |
| --- | --- |
| `wiring-diagram.svg` | Colour-coded wiring diagram (open in a browser) |
| `esp32_reader/esp32_reader.ino` | ESP32 firmware (Arduino IDE) |
| `../scripts/simulate-device.js` | Pretends to be the reader, so you can demo without hardware |

## How one tap works (single tap, as assumed in Module 5)

1. Student taps their **own RFID ID card** on the RC522.
2. ESP32 sends the card UID to `POST /api/device/tap` with header `X-Device-Key`.
3. Server looks the card up in `users.rfid_tag`:
   - student **holds an issued item** → the tap is a **return** (condition recorded as *Good, pending staff inspection*)
   - otherwise → the tap **issues the approved booking that is due now** (from 15 min before it starts until it ends)
4. Reply `unlock:true` → relay ON → latch opens for 5 s. Anything else → latch stays **locked**, red LED + 3 beeps = **use the manual counter** (the fallback in Module 5).

Refused on purpose (student goes to the counter): unknown card, inactive account, no approved booking now, more than one booking due now, more than one item held, item in maintenance/damaged/lost.

## Parts list

| Part | Notes |
| --- | --- |
| ESP32 DevKit (ESP32-WROOM-32) | powered from USB 5 V |
| RC522 RFID module + cards/tags | 13.56 MHz, **3.3 V only** |
| 1-channel 5 V relay module | opto-isolated; prefer one that works with 3.3 V logic |
| 12 V solenoid lock, **fail-secure** | locked when unpowered, opens only while energised |
| 12 V DC adapter, 2 A | powers only the lock |
| 1N4007 diode | across the lock coil (stripe/cathode to +12 V) |
| 2 LEDs (green, red) + 2 × 220 Ω | feedback |
| Active buzzer (3.3 V-compatible) | feedback |
| Breadboard + jumper wires | |

## Pin table

| RC522 pin | ESP32 pin | Wire |
| --- | --- | --- |
| 3.3V | 3V3 | red |
| GND | GND | black |
| SDA (SS) | GPIO5 | orange |
| SCK | GPIO18 | blue |
| MOSI | GPIO23 | green |
| MISO | GPIO19 | purple |
| RST | GPIO22 | grey |
| IRQ | not connected | – |

| Part | ESP32 pin | Note |
| --- | --- | --- |
| Green LED (+220 Ω to GND) | GPIO25 | success |
| Red LED (+220 Ω to GND) | GPIO27 | refused / error |
| Buzzer | GPIO33 | feedback |
| Relay IN | GPIO26 | `RELAY_ACTIVE_LOW = true` in the firmware; set to `false` if your module is active-high |
| Relay VCC | VIN (5 V) | |
| Relay GND | GND | |

**12 V latch circuit (separate from the ESP32):** +12 V → relay **COM**; relay **NO** → lock +; lock – → 12 V –. Put the 1N4007 across the lock coil. The relay contacts keep this circuit isolated from the ESP32.

## Setup

1. Server: copy `server/.env.example` to `server/.env` and set `DEVICE_KEY` to a long random string.
2. Run SportEase (`npm run dev`). Find the computer's IP (`ipconfig`). The ESP32 and the computer must be on the **same Wi-Fi**. Allow port 5174 in the Windows firewall.
3. Arduino IDE: install the **esp32** board package, and the libraries **MFRC522** and **ArduinoJson (7.x)**.
4. Open `esp32_reader/esp32_reader.ino`, edit `WIFI_SSID`, `WIFI_PASS`, `SERVER_URL` (for example `http://192.168.1.50:5174`) and `DEVICE_KEY`. Upload. Open Serial Monitor at **115200**.
5. At start-up it prints the RC522 version (anything except `0x00`/`0xFF` means the wiring works) and a **server ping** (`HTTP 200` means Wi-Fi, server and key are OK; `401` means wrong key).
6. Register a real card: tap it. The serial monitor prints its UID (the server replies "Card not registered"). In SportEase go to **Admin → Users → Edit**, paste the UID into **RFID card (UID)**, and Save.

## Demo with no hardware

Every student already has a virtual card (`ST-XXXXXXXX`, shown in Admin → Users). With the server running:

```
node scripts/simulate-device.js ST-XXXXXXXX
```

1. Student books equipment for the current time on the portal (booking is auto-approved).
2. Run the command: reply `action: issue, unlock: true` (latch would open).
3. Run it again: reply `action: return, unlock: true`.
4. Run it with a card that has no booking: `ok: false` (latch stays locked, use the counter).

Every tap is in **Admin → RFID Desk → Recent RFID activity** (type `student`).

## Bench test (Module 5, next step 2): check the assumptions with real data

Do at least **100 taps** on real student ID cards. The firmware prints one CSV line per tap:
`TAP,millis,uid,http,latency_ms,action,unlock`, and a `STATS` line every 10 taps.

| Module 5 assumption | How to measure | Target |
| --- | --- | --- |
| #1 tap is fast, first-tap failures ≤ 10% | Count cards that needed **more than one presentation** to be read, out of 100. Mean `latency_ms` from the CSV. | failures ≤ 10%, tap well under 30 s |
| #4 Wi-Fi stable enough | Count CSV lines where `http` is not 200 (or `no_wifi`) | as low as possible, and every one falls back to the counter |
| #5 latch opens reliably | Count latch opens out of the number of `unlock=1` replies (at least 20) | 20 / 20 |
| #3 database stays in sync | After the test, compare the equipment status in Admin with the real items | no mismatch |

Write the results in your Module 5 workbook, replacing the assumed numbers (10% failure, 0.5 min tap).

## Known limits

- One latch / one item per tap card at a time. The prototype has **no multi-bay locker control**.
- Slot capacity and no-show handling are not implemented yet.
- The firmware has never run on real hardware. Expect to adjust pins, relay polarity or timing.
- Change `DEVICE_KEY` and `JWT_SECRET` before any real use.
