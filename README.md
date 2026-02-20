# VibeSync

A real-time synchronized music listening app. One person hosts, everyone else listens — all perfectly in sync. Built with YouTube IFrame Player API, Socket.io, Next.js, and Node.js.

**Live Demo:** [vibe-sync-delta.vercel.app](https://vibe-sync-delta.vercel.app)

---

## How It Works

1. **Host** creates a room → gets a 4-letter room code
2. Host searches for any song via YouTube
3. Host selects a track — it starts playing for everyone in the room
4. **Guests** join using the room code → click "Start Listening" (browser autoplay policy) → audio syncs instantly
5. Host controls play, pause, and seek — all guests follow in real time

No accounts. No downloads. Just share the code and vibe.

---

## Features

- Real-time audio sync via Socket.io (play, pause, seek all broadcast to guests)
- YouTube search powered by YouTube Data API v3
- Host transfers automatically if the host disconnects
- Late joiners receive the current track state immediately
- Autoplay unlock button for guests (browser policy compliance)
- Neobrutalist UI — black, white, yellow

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS v4 |
| Audio Player | YouTube IFrame Player API (`react-youtube`) |
| Real-time Sync | Socket.io (WebSockets) |
| Backend | Node.js, Express |
| Search | YouTube Data API v3 |
| Frontend Hosting | Vercel |
| Backend Hosting | Render |

---

## Project Structure

```
VibeSync/
├── server.js                  # Express + Socket.io backend
├── package.json               # Backend dependencies
├── render.yaml                # Render deployment config
└── vibesync-frontend/
    ├── app/
    │   └── page.tsx           # Main React component (entire UI)
    ├── package.json           # Frontend dependencies
    └── next.config.ts         # Next.js config
```

---

## Local Development

### Prerequisites

- Node.js 18+
- A YouTube Data API v3 key ([get one here](https://console.cloud.google.com/))

### 1. Clone the repo

```bash
git clone https://github.com/aaditx/VibeSync.git
cd VibeSync
```

### 2. Set up the backend

```bash
# Install dependencies
npm install

# Create a .env file
echo "YOUTUBE_API_KEY=your_api_key_here" > .env
echo "PORT=4000" >> .env

# Start the backend
node server.js
```

Backend runs at `http://localhost:4000`

### 3. Set up the frontend

```bash
cd vibesync-frontend

# Install dependencies
npm install

# Create a .env.local file
echo "NEXT_PUBLIC_BACKEND_URL=http://localhost:4000" > .env.local

# Start the frontend
npm run dev
```

Frontend runs at `http://localhost:3000`

### 4. Test it

Open two browser tabs at `http://localhost:3000`:
- Tab 1: Create a room → search and load a track
- Tab 2: Join with the room code → click "Start Listening"

---

## Environment Variables

### Backend (Render / `.env`)

| Variable | Description |
|---|---|
| `YOUTUBE_API_KEY` | YouTube Data API v3 key from Google Cloud Console |
| `PORT` | Server port (default: 4000, Render sets this automatically) |
| `FRONTEND_URL` | Frontend origin for CORS (optional, defaults to `*`) |

### Frontend (Vercel / `.env.local`)

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_BACKEND_URL` | Full URL of the backend (e.g. `https://vibesync-7f4i.onrender.com`) |

---

## Deployment

### Backend → Render

1. Connect your GitHub repo to [Render](https://render.com)
2. New **Web Service** → select the repo root
3. Build command: `npm install`
4. Start command: `node server.js`
5. Add environment variable: `YOUTUBE_API_KEY = your_key`
6. Deploy

### Frontend → Vercel

1. Connect your GitHub repo to [Vercel](https://vercel.com)
2. Set root directory to `vibesync-frontend`
3. Add environment variable: `NEXT_PUBLIC_BACKEND_URL = https://your-render-url.onrender.com`
4. Deploy

Vercel and Render both auto-redeploy on every push to `main`.

---

## Architecture

```
Browser (Host)                    Browser (Guest)
     │                                  │
     │  YouTube IFrame Player           │  YouTube IFrame Player
     │  (hidden, audio only)            │  (hidden, audio only)
     │                                  │
     └────────────┐     ┌───────────────┘
                  │     │
                  ▼     ▼
             Socket.io Server (Render)
                  │
                  ▼
         /api/search → YouTube Data API v3
```

- The server never touches audio — YouTube streams directly in each user's browser
- Socket.io only passes lightweight sync events (play/pause/seek timestamps)
- This bypasses all server-side YouTube restrictions entirely

---

## Socket.io Events

| Event | Direction | Description |
|---|---|---|
| `create_room` | client → server | Creates a new room, returns 4-letter code |
| `join_room` | client → server | Join existing room, returns current track state |
| `load_track` | host → server → guests | Broadcast new track to all guests |
| `play` | host → server → guests | Broadcast play + current timestamp |
| `pause` | host → server → guests | Broadcast pause + current timestamp |
| `seek` | host → server → guests | Broadcast seek to timestamp |
| `user_joined` | server → host | Notifies host when a guest joins |
| `host_transferred` | server → new host | Sent when host disconnects |

---

## API

### `GET /`
Health check.
```json
{ "status": "ok", "service": "VibeSync Backend" }
```

### `GET /api/search?q=<query>`
Search YouTube. Returns up to 8 results.
```json
[
  {
    "videoId": "dQw4w9WgXcQ",
    "title": "Rick Astley - Never Gonna Give You Up",
    "channel": "Rick Astley",
    "thumbnail": "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg"
  }
]
```

---

## Known Limitations

- **YouTube quota:** Free tier = 10,000 units/day. Each search costs 100 units = ~100 searches/day. For higher usage, request a quota increase in Google Cloud Console or implement search result caching.
- **Embedding restrictions:** Rarely, some YouTube videos have embedding disabled by the uploader. Just search for a different version.
- **Audio-only:** The YouTube IFrame always creates a video element — it's hidden off-screen (`top: -9999px`), so only audio plays. True audio-only extraction from YouTube is not possible without violating YouTube's ToS.
- **Room persistence:** Rooms live in server memory. If the server restarts, all active rooms are lost.
- **Single instance:** Running multiple server instances requires a Redis adapter for Socket.io to share room state.

---

## License

MIT
