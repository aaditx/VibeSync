const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const youtubedl = require('youtube-dl-exec');

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
// STEP 1: EXPRESS ENDPOINT FOR YOUTUBE AUDIO EXTRACTION
// -------------------------------------------------------------------
app.post('/api/extract-audio', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'YouTube URL is required' });
  }

  try {
    const output = await youtubedl(url, {
      dumpJson: true,
      format: 'bestaudio',
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
      addHeader: ['referer:https://www.youtube.com', 'user-agent:googlebot'],
    });

    res.json({
      title: output.title,
      audioUrl: output.url, 
      thumbnail: output.thumbnail,
    });
  } catch (error) {
    console.error('Extraction Error:', error.message);
    res.status(500).json({ error: 'Failed to extract audio stream.' });
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