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

// Bug fix: defined outside connection handler so it's not recreated per socket
const getRoomUsers = (roomCode) => {
  const room = rooms[roomCode];
  if (!room) return [];
  return Array.from(room.users.entries()).map(([id, name]) => ({
    name,
    isHost: id === room.host,
  }));
};

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Bug fix: typeof callback guard prevents crash if called without ack
  socket.on('create_room', ({ name } = {}, callback) => {
    if (typeof callback !== 'function') return;
    const displayName = (name || 'Host').trim().slice(0, 20);
    let roomCode;
    do { roomCode = generateRoomCode(); } while (rooms[roomCode]);
    rooms[roomCode] = { host: socket.id, users: new Map(), currentTrack: null, queue: [], messages: [], requests: [] };
    rooms[roomCode].users.set(socket.id, displayName);
    socket.join(roomCode);
    console.log(`Room ${roomCode} created by ${displayName} (${socket.id})`);
    callback({ success: true, roomCode, isHost: true });
    io.to(roomCode).emit('room_users', getRoomUsers(roomCode));
  });

  socket.on('join_room', ({ code, name } = {}, callback) => {
    if (typeof callback !== 'function') return;
    const roomCode = (code || '').toUpperCase();
    const displayName = (name || 'Listener').trim().slice(0, 20);
    if (rooms[roomCode]) {
      rooms[roomCode].users.set(socket.id, displayName);
      socket.join(roomCode);
      console.log(`${displayName} (${socket.id}) joined room ${roomCode}`);
      callback({ success: true, roomCode, isHost: false, currentTrack: rooms[roomCode].currentTrack, queue: rooms[roomCode].queue, messages: rooms[roomCode].messages, requests: rooms[roomCode].requests });
      io.to(roomCode).emit('room_users', getRoomUsers(roomCode));
      socket.to(roomCode).emit('user_joined'); // Bug fix: removed unused userId payload
    } else {
      callback({ success: false, message: 'Room not found or expired.' });
    }
  });

  // Bug fix: = {} defaults prevent destructuring crash on malformed payloads
  socket.on('load_track', ({ roomCode, trackData } = {}) => {
    if (rooms[roomCode] && rooms[roomCode].host === socket.id) {
      rooms[roomCode].currentTrack = trackData;
      socket.to(roomCode).emit('load_track', trackData);
    }
  });

  socket.on('play', ({ roomCode, time } = {}) => {
    if (rooms[roomCode] && rooms[roomCode].host === socket.id) {
      socket.to(roomCode).emit('play', { time });
    }
  });

  socket.on('pause', ({ roomCode, time } = {}) => {
    if (rooms[roomCode] && rooms[roomCode].host === socket.id) {
      socket.to(roomCode).emit('pause', { time });
    }
  });

  socket.on('seek', ({ roomCode, time } = {}) => {
    if (rooms[roomCode] && rooms[roomCode].host === socket.id) {
      socket.to(roomCode).emit('seek', { time });
    }
  });

  socket.on('add_to_queue', ({ roomCode, trackData } = {}) => {
    if (rooms[roomCode] && rooms[roomCode].host === socket.id && trackData) {
      rooms[roomCode].queue.push(trackData);
      io.to(roomCode).emit('queue_update', rooms[roomCode].queue);
    }
  });

  socket.on('remove_from_queue', ({ roomCode, index } = {}) => {
    const room = rooms[roomCode];
    if (room && room.host === socket.id && typeof index === 'number') {
      room.queue.splice(index, 1);
      io.to(roomCode).emit('queue_update', room.queue);
    }
  });

  socket.on('track_ended', ({ roomCode } = {}) => {
    const room = rooms[roomCode];
    if (!room || room.host !== socket.id) return;
    if (room.queue.length > 0) {
      const next = room.queue.shift();
      room.currentTrack = next;
      io.to(roomCode).emit('load_track', next);
      io.to(roomCode).emit('queue_update', room.queue);
      // Auto-play next track after a short delay for clients to load
      setTimeout(() => {
        io.to(roomCode).emit('play', { time: 0 });
      }, 1500);
    } else {
      room.currentTrack = null;
    }
  });

  socket.on('send_message', ({ roomCode, text } = {}) => {
    const room = rooms[roomCode];
    if (!room || !text || !room.users.has(socket.id)) return;
    const name = room.users.get(socket.id);
    const msg = { name, text: text.toString().slice(0, 200), time: Date.now() };
    room.messages.push(msg);
    if (room.messages.length > 100) room.messages.shift();
    io.to(roomCode).emit('chat_message', msg);
  });

  socket.on('send_reaction', ({ roomCode, emoji } = {}) => {
    const room = rooms[roomCode];
    if (!room || !emoji || !room.users.has(socket.id)) return;
    io.to(roomCode).emit('reaction', { emoji });
  });

  socket.on('request_track', ({ roomCode, trackData } = {}) => {
    const room = rooms[roomCode];
    if (!room || !trackData || !room.users.has(socket.id) || room.host === socket.id) return;
    const name = room.users.get(socket.id);
    room.requests.push({ ...trackData, requestedBy: name });
    io.to(roomCode).emit('requests_update', room.requests);
  });

  socket.on('approve_request', ({ roomCode, index, addToQueue } = {}) => {
    const room = rooms[roomCode];
    if (!room || room.host !== socket.id || typeof index !== 'number') return;
    const [req] = room.requests.splice(index, 1);
    if (!req) return;
    const { requestedBy, ...trackData } = req;
    if (addToQueue) {
      room.queue.push(trackData);
      io.to(roomCode).emit('queue_update', room.queue);
    } else {
      room.currentTrack = trackData;
      room.queue = [];
      io.to(roomCode).emit('load_track', trackData);
      io.to(roomCode).emit('queue_update', room.queue);
    }
    io.to(roomCode).emit('requests_update', room.requests);
  });

  socket.on('reject_request', ({ roomCode, index } = {}) => {
    const room = rooms[roomCode];
    if (!room || room.host !== socket.id || typeof index !== 'number') return;
    room.requests.splice(index, 1);
    io.to(roomCode).emit('requests_update', room.requests);
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    for (const [roomCode, room] of Object.entries(rooms)) {
      if (room.users.has(socket.id)) {
        room.users.delete(socket.id);
        if (room.users.size === 0) {
          delete rooms[roomCode];
          console.log(`Room ${roomCode} deleted (empty).`);
        } else {
          if (room.host === socket.id) {
            room.host = Array.from(room.users.keys())[0];
            io.to(room.host).emit('host_transferred', {});
            console.log(`Host transferred in room ${roomCode}`);
          }
          io.to(roomCode).emit('room_users', getRoomUsers(roomCode));
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
