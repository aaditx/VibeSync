const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const play = require('play-dl');

// In-memory cache: videoId -> { filePath, title, thumbnail, size }
const audioCache = new Map();

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

// Initialize Socket.io with CORS for the Next.js frontend
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST'],
  },
});

// -------------------------------------------------------------------
// STEP 1: EXPRESS ENDPOINT FOR YOUTUBE AUDIO EXTRACTION (play-dl)
// -------------------------------------------------------------------
app.post('/api/extract-audio', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'YouTube URL is required' });
  }

  try {
    // Get video metadata
    const info = await play.video_info(url);
    const details = info.video_details;
    const videoId = details.id;
    const title = details.title || 'Unknown Title';
    const thumbnail =
      details.thumbnails?.[details.thumbnails.length - 1]?.url || '';

    // Serve from cache if already downloaded
    if (audioCache.has(videoId)) {
      console.log(`Serving cached audio for ${videoId}`);
      return res.json({ title, audioUrl: `/api/audio/${videoId}`, thumbnail });
    }

    // Download audio stream to a temp file
    const filePath = path.join(os.tmpdir(), `vs_${videoId}.webm`);
    console.log(`Downloading audio for ${videoId}...`);
    const stream = await play.stream(url, { quality: 2 });

    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(filePath);
      stream.stream.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    const { size } = fs.statSync(filePath);
    audioCache.set(videoId, { filePath, title, thumbnail, size });
    console.log(`Audio ready: ${videoId} (${(size / 1024 / 1024).toFixed(1)} MB)`);

    res.json({ title, audioUrl: `/api/audio/${videoId}`, thumbnail });
  } catch (error) {
    console.error('Extraction Error:', error.message);
    res.status(500).json({ error: 'Failed to extract audio.' });
  }
});

// -------------------------------------------------------------------
// STEP 1b: SERVE DOWNLOADED AUDIO WITH RANGE SUPPORT
// -------------------------------------------------------------------
app.get('/api/audio/:videoId', (req, res) => {
  const { videoId } = req.params;
  const cached = audioCache.get(videoId);

  if (!cached) return res.status(404).send('Audio not found');

  const { filePath, size } = cached;
  const range = req.headers.range;

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', 'audio/webm');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : size - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': chunkSize,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': size });
    fs.createReadStream(filePath).pipe(res);
  }
});

// -------------------------------------------------------------------
// STEP 2: SOCKET.IO ROOMS AND SYNCHRONIZATION LOGIC
// -------------------------------------------------------------------
const rooms = {};

const generateRoomCode = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
};

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // ---- ROOM MANAGEMENT ----
  socket.on('create_room', (callback) => {
    let roomCode;
    do {
      roomCode = generateRoomCode();
    } while (rooms[roomCode]);

    rooms[roomCode] = {
      host: socket.id,
      users: new Set(),
    };
    rooms[roomCode].users.add(socket.id);

    socket.join(roomCode);
    console.log(`Room ${roomCode} created by host ${socket.id}`);
    
    callback({ success: true, roomCode, isHost: true });
  });

  socket.on('join_room', (code, callback) => {
    const roomCode = code.toUpperCase();

    if (rooms[roomCode]) {
      rooms[roomCode].users.add(socket.id);
      socket.join(roomCode);
      console.log(`User ${socket.id} joined room ${roomCode}`);
      
      callback({ success: true, roomCode, isHost: false });
      
      socket.to(roomCode).emit('user_joined', { userId: socket.id });
    } else {
      callback({ success: false, message: 'Room not found or expired.' });
    }
  });

  // ---- AUDIO SYNCHRONIZATION (HOST ONLY) ----
  socket.on('load_track', ({ roomCode, trackData }) => {
    if (rooms[roomCode] && rooms[roomCode].host === socket.id) {
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

  // ---- CLEANUP ON DISCONNECT ----
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
          io.to(room.host).emit('host_transferred', { message: 'You are now the host' });
          console.log(`Host transferred to ${room.host} in room ${roomCode}`);
        }
      }
    }
  });
});

const PORT = process.env.PORT || 4000;

server.listen(PORT, () => {
  console.log(`VibeSync Backend running on http://localhost:${PORT}`);
});