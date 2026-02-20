const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST'],
  },
});

// -------------------------------------------------------------------
// HEALTH CHECK
// -------------------------------------------------------------------
app.get('/', (req, res) => res.json({ status: 'ok', service: 'VibeSync Backend' }));

// -------------------------------------------------------------------
// YOUTUBE SEARCH via Data API v3
// -------------------------------------------------------------------
app.get('/api/search', (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing search query' });

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'YouTube API key not configured on server.' });

  const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=8&q=${encodeURIComponent(q)}&key=${apiKey}`;

  https.get(searchUrl, (resp) => {
    let data = '';
    resp.on('data', (chunk) => (data += chunk));
    resp.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        if (parsed.error) return res.status(500).json({ error: parsed.error.message });
        const results = (parsed.items || []).map((item) => ({
          videoId: item.id.videoId,
          title: item.snippet.title,
          channel: item.snippet.channelTitle,
          thumbnail: item.snippet.thumbnails.medium?.url || item.snippet.thumbnails.default?.url,
        }));
        res.json(results);
      } catch (e) {
        res.status(500).json({ error: 'Failed to parse YouTube API response.' });
      }
    });
  }).on('error', (err) => res.status(500).json({ error: err.message }));
});

// -------------------------------------------------------------------
// SOCKET.IO � ROOM MANAGEMENT & SYNC
// -------------------------------------------------------------------
const rooms = {};

const generateRoomCode = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return code;
};

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('create_room', (callback) => {
    let roomCode;
    do { roomCode = generateRoomCode(); } while (rooms[roomCode]);
    rooms[roomCode] = { host: socket.id, users: new Set(), currentTrack: null };
    rooms[roomCode].users.add(socket.id);
    socket.join(roomCode);
    console.log(`Room ${roomCode} created by ${socket.id}`);
    callback({ success: true, roomCode, isHost: true });
  });

  socket.on('join_room', (code, callback) => {
    const roomCode = code.toUpperCase();
    if (rooms[roomCode]) {
      rooms[roomCode].users.add(socket.id);
      socket.join(roomCode);
      console.log(`User ${socket.id} joined room ${roomCode}`);
      callback({ success: true, roomCode, isHost: false, currentTrack: rooms[roomCode].currentTrack });
      socket.to(roomCode).emit('user_joined', { userId: socket.id });
    } else {
      callback({ success: false, message: 'Room not found or expired.' });
    }
  });

  socket.on('load_track', ({ roomCode, trackData }) => {
    if (rooms[roomCode] && rooms[roomCode].host === socket.id) {
      rooms[roomCode].currentTrack = trackData;
      socket.to(roomCode).emit('load_track', trackData);
    }
  });

  socket.on('play', ({ roomCode, time }) => {
    if (rooms[roomCode] && rooms[roomCode].host === socket.id) {
      socket.to(roomCode).emit('play', { time });
    }
  });

  socket.on('pause', ({ roomCode, time }) => {
    if (rooms[roomCode] && rooms[roomCode].host === socket.id) {
      socket.to(roomCode).emit('pause', { time });
    }
  });

  socket.on('seek', ({ roomCode, time }) => {
    if (rooms[roomCode] && rooms[roomCode].host === socket.id) {
      socket.to(roomCode).emit('seek', { time });
    }
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    for (const [roomCode, room] of Object.entries(rooms)) {
      if (room.users.has(socket.id)) {
        room.users.delete(socket.id);
        if (room.users.size === 0) {
          delete rooms[roomCode];
          console.log(`Room ${roomCode} deleted (empty).`);
        } else if (room.host === socket.id) {
          room.host = Array.from(room.users)[0];
          io.to(room.host).emit('host_transferred', {});
          console.log(`Host transferred in room ${roomCode}`);
        }
      }
    }
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`VibeSync Backend running on http://localhost:${PORT}`);

  // Keep Render free tier alive by self-pinging every 14 minutes.
  // Render spins down after 15 min of inactivity — this prevents that.
  const SELF_URL = process.env.RENDER_EXTERNAL_URL;
  if (SELF_URL) {
    setInterval(() => {
      https.get(`${SELF_URL}/`).on('error', () => {});
      console.log('[keep-alive] pinged self');
    }, 14 * 60 * 1000);
  }
});
