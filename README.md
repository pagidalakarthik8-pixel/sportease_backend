# SportEase Backend API

Backend REST API for **SportEase – Smart Sports Equipment & Booking Management System**.

Built with **Node.js (>=22.5.0)**, **Express**, and **SQLite (built-in node:sqlite DatabaseSync)**.

---

## Features

- **Authentication & Roles**: JWT-based authentication with Admin and Student roles.
- **Equipment & Ground Bookings**: Booking management with overlap prevention.
- **RFID Desk & Smart Locker Integration**: RFID tag resolution, equipment issuing and return, latch unlock endpoint (`/api/device/tap`).
- **Notification & Messaging Service**: In-app notifications and WhatsApp/SMS alert queue via Twilio (supports both click-to-send and automatic modes).
- **Admin Analytics**: Real-time stats on equipment usage, active loans, and booking trends.

---

## Local Setup

### Prerequisites
- **Node.js**: v22.5.0 or newer (uses built-in `node:sqlite`).

### Installation

```bash
npm install
```

### Environment Configuration (Optional)

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Available variables:
- `PORT`: Server port (default: `5174`)
- `JWT_SECRET`: Secret key for JWT signing
- `DEVICE_KEY`: Shared secret key for ESP32 reader (`X-Device-Key` header)
- `TWILIO_ACCOUNT_SID`: (Optional) Twilio Account SID for auto WhatsApp/SMS
- `TWILIO_AUTH_TOKEN`: (Optional) Twilio Auth Token
- `TWILIO_WHATSAPP_FROM`: (Optional) Twilio WhatsApp number
- `TWILIO_SMS_FROM`: (Optional) Twilio SMS number
- `ADMIN_PHONE`: (Optional) WhatsApp number to receive booking alerts
- `DEFAULT_COUNTRY_CODE`: Country code for phone numbers (default: `91`)

### Run the Server

```bash
npm start
```

Or run with auto-reload:

```bash
npm run dev
```

The server starts at `http://localhost:5174`.
Health check: `http://localhost:5174/health`

---

## Deployment to Render

1. Go to [Render](https://render.com) and click **New +** -> **Web Service**.
2. Connect your GitHub repository: `https://github.com/pagidalakarthik8-pixel/sportease_backend.git`.
3. Set the following details:
   - **Name**: `sportease-backend`
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. Under **Environment Variables**, add:
   - `NODE_VERSION`: `22.12.0`
   - `JWT_SECRET`: (your secure secret string)
   - `DEVICE_KEY`: (your device key string)
5. Click **Deploy Web Service**.
6. Note down the deployed URL (e.g., `https://sportease-backend.onrender.com`). You will set this as `VITE_API_URL` on the frontend!
