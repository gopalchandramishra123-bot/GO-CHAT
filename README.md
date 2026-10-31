# GO-CHAT — Production Deployment Guide

> **Modern, Minimal Room-Based Chatting Platform**
> Frontend: **Netlify** | Backend: **Google Cloud Run** | Transport: **WebSockets + WebRTC P2P Data Channels**

---

## 🏛️ Production Architecture

```
  +-------------------------------------------------------------------------+
  |                                 BROWSERS                                |
  |   (Chrome Desktop / Firefox / Android Mobile / Safari iOS / Tablets)   |
  +-------------------------------------------------------------------------+
             |                                                  |
             | 1. HTTP/HTTPS (Static Assets)                    | 2. WebSocket WSS
             v                                                  v
  +-----------------------+                         +-----------------------+
  |    NETLIFY (CDN)      |                         |   GOOGLE CLOUD RUN    |
  |  - index.html         |                         |  - signalling-server  |
  |  - style.css          |                         |  - In-memory rooms    |
  |  - script.js          |                         |  - Zero database      |
  |  - config.js          |                         |  - Heartbeat / ping   |
  +-----------------------+                         +-----------------------+
             |                                                  |
             |                                                  | 3. SDP Offer/Answer
             |                                                  |    & ICE Candidates
             v                                                  v
  +-------------------------------------------------------------------------+
  |                    DIRECT WebRTC P2P DATA CHANNELS                      |
  |               (End-to-End Messages Between Connected Peers)             |
  +-------------------------------------------------------------------------+
```

1. **Netlify**: Serves the lightweight HTML, CSS, and Vanilla JavaScript assets globally via CDN.
2. **Google Cloud Run**: Runs the dedicated Node.js WebSocket signalling backend (`signalling-server.js` or container). It coordinates room memberships, ownership, and relays WebRTC handshakes.
3. **WebRTC P2P**: Once connected, chat messages flow directly peer-to-peer across devices over encrypted `RTCDataChannel` connections, backed by server relay for maximum resilience.
4. **Zero Persistent Storage**: No database (no Firebase, no Supabase, no SQL/NoSQL). Zero `localStorage`, `sessionStorage`, or `IndexedDB` message storage.

---

## 🚀 Part 1: Deploy Backend to Google Cloud Run

Google Cloud Run provides a serverless container environment with built-in HTTPS/WSS termination, auto-scaling, and native WebSocket support.

### Prerequisites
- A Google Cloud Project with billing enabled.
- Google Cloud SDK (`gcloud` CLI) installed, or use **Google Cloud Shell** in your browser.

---

### Method A: Deploy directly with Google Cloud CLI (Recommended)

1. Open your terminal in the project directory (or in Google Cloud Shell).
2. Set your active Google Cloud project:
   ```bash
   gcloud config set project YOUR_PROJECT_ID
   ```
3. Enable the Cloud Run and Cloud Build APIs:
   ```bash
   gcloud services enable run.googleapis.com cloudbuild.googleapis.com
   ```
4. Deploy the backend service from source:
   ```bash
   gcloud run deploy go-chat-backend \
     --source . \
     --platform managed \
     --region us-central1 \
     --allow-unauthenticated \
     --port 8080
   ```
   *(The project's `Dockerfile` automatically packages `signalling-server.js`).*

5. When deployment finishes, Cloud Run outputs your Service URL:
   ```text
   Service [go-chat-backend] revision has been deployed and is serving 100 percent of traffic.
   Service URL: https://go-chat-backend-xyz123-uc.a.run.app
   ```
6. **Your WebSocket Signalling URL** is simply the Service URL prefixed with `wss://`:
   ```text
   wss://go-chat-backend-xyz123-uc.a.run.app
   ```

---

### Method B: Deploy via Google Cloud Console UI

1. Open [Google Cloud Run Console](https://console.cloud.google.com/run).
2. Click **Create Service**.
3. Choose **Continuously deploy from a repository** (connect your GitHub repository) or build with Cloud Build.
4. Set:
   - **Service name**: `go-chat-backend`
   - **Region**: Choose your preferred region (e.g., `us-central1` or `asia-southeast1`)
   - **Authentication**: Select **Allow unauthenticated invocations**
   - **Container port**: `8080`
5. Click **Create**.
6. Copy the generated HTTPS URL and convert `https://` to `wss://`.

---

## 🌐 Part 2: Deploy Frontend to Netlify

### Step 1: Configure the Backend URL in the Frontend

Open `config.js` in your project and paste your Cloud Run WebSocket URL into `PRODUCTION_BACKEND_WSS_URL`:

```javascript
// config.js
export const PRODUCTION_BACKEND_WSS_URL = 'wss://go-chat-backend-xyz123-uc.a.run.app';
```

*(Note: You can also leave this empty and configure the URL via the in-app **Server Settings** modal or via the `?server=wss://...` query parameter at runtime!)*

### Step 2: Push to Git & Deploy on Netlify

1. Commit and push your changes to your GitHub/GitLab repository:
   ```bash
   git add .
   git commit -m "Configure production deployment for Netlify and Cloud Run"
   git push origin main
   ```
2. Log in to [Netlify](https://app.netlify.com).
3. Click **Add new site** → **Import an existing project**.
4. Select your Git repository.
5. Netlify will automatically detect the pre-configured `netlify.toml`:
   - **Build command**: `npm run build`
   - **Publish directory**: `dist`
6. Click **Deploy Site**.
7. Netlify will build and deploy your site in ~30 seconds (e.g. `https://your-go-chat.netlify.app`).

---

## 📱 Part 3: Testing Real Multi-Device Communication

Once deployed:

1. **Desktop Chrome**:
   - Navigate to `https://your-go-chat.netlify.app`.
   - The top status pill displays: `🟢 Signalling: Connected`.
   - Enter Name: **Alex**, Room: **402**. Click **JOIN ROOM**.
   - Alex is assigned as the **★ Owner** of Room 402.

2. **Desktop Firefox**:
   - Open `https://your-go-chat.netlify.app` in Firefox (or private browsing).
   - Enter Name: **Taylor**, Room: **402**. Click **JOIN ROOM**.
   - Both users will immediately see each other in the **Online Members** list (`2 members online`).
   - A real-time join notification announces: `Taylor joined the room`.

3. **Android / iPhone Mobile**:
   - Open Chrome or Safari on your mobile device.
   - Navigate to `https://your-go-chat.netlify.app`.
   - Enter Name: **Jordan**, Room: **402**.
   - Instant real-time communication flows between mobile and desktop devices via WebRTC!

4. **Verify Room Isolation**:
   - Open a separate browser tab and join Room **999**.
   - Room 999 is completely isolated; members and messages from Room 402 never appear in Room 999.

5. **Verify Ownership & Cleanup**:
   - If **Alex** (Owner) clicks **Leave Room**, **Taylor** automatically becomes the new **Owner**.
   - When all members leave Room 402, the room and its temporary state are completely destroyed from the Cloud Run server memory.

---

## 💻 Local Development

To run both the frontend and backend locally in one command:

```bash
# Install dependencies
npm install

# Run the dev server
npm run dev
```

- Web application: `http://localhost:3000`
- Signalling WebSocket: `ws://localhost:3000`
- API Health Check: `http://localhost:3000/health`
