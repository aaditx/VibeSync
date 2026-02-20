const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');

// -------------------------------------------------------------------
// AUTO-UPDATE yt-dlp BINARY TO LATEST VERSION ON STARTUP
// -------------------------------------------------------------------
const ytDlpPath = path.join(os.tmpdir(), 'yt-dlp');

function downloadLatestYtDlp() {
  return new Promise((resolve) => {
    console.log('Downloading latest yt-dlp binary...');
    const file = fs.createWriteStream(ytDlpPath);
    const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
    https.get(url, (res) => {
      // Follow redirects
      if (res.statusCode === 302 || res.statusCode === 301) {
        https.get(res.headers.location, (res2) => {
          res2.pipe(file);
          file.on('finish', () => {
            file.close();
            try { fs.chmodSync(ytDlpPath, '755'); } catch(e) {}
            console.log('yt-dlp updated successfully.');
            resolve(ytDlpPath);
          });
        }).on('error', () => resolve(null));
      } else {
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          try { fs.chmodSync(ytDlpPath, '755'); } catch(e) {}
          console.log('yt-dlp updated successfully.');
          resolve(ytDlpPath);
        });
      }
    }).on('error', (err) => {
      console.error('Failed to download yt-dlp:', err.message);
      resolve(null);
    });
  });
}

// Write YouTube cookies from env variable to a temp file (for server deployments)
let cookiesFilePath = null;
if (process.env.YOUTUBE_COOKIES) {
  cookiesFilePath = path.join(os.tmpdir(), 'yt-cookies.txt');
  fs.writeFileSync(cookiesFilePath, process.env.YOUTUBE_COOKIES);
  console.log('YouTube cookies loaded from environment.');
}

// Will hold the youtubedl instance pointing to the latest binary
let youtubedl = require('youtube-dl-exec');

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
    const commonOpts = {
      noCheckCertificates: true,
      noWarnings: true,
      addHeader: ['referer:https://www.youtube.com', 'user-agent:Mozilla/5.0'],
    };
    if (cookiesFilePath) commonOpts.cookies = cookiesFilePath;

    // Pass 1: get video metadata (title, thumbnail)
    const info = await youtubedl(url, { ...commonOpts, dumpJson: true });

    // Pass 2: get the actual stream URL using --get-url (most reliable)
    const FORMAT = 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best';
    const rawUrl = await youtubedl(url, {
      ...commonOpts,
      getUrl: true,
      format: FORMAT,
    });

    // getUrl returns a string or array of strings
    const streamUrl = Array.isArray(rawUrl) ? rawUrl[0] : rawUrl;

    if (!streamUrl || typeof streamUrl !== 'string' || !streamUrl.startsWith('http')) {
      console.error('getUrl returned unexpected value:', rawUrl);
      return res.status(500).json({ error: 'Could not extract stream URL.' });
    }

    const encodedUrl = Buffer.from(streamUrl).toString('base64');
    res.json({
      title: info.title,
      audioUrl: `/api/proxy-audio?url=${encodedUrl}`,
      thumbnail: info.thumbnail,
    });
  } catch (error) {
    console.error('Extraction Error:', error.message);
    res.status(500).json({ error: 'Failed to extract audio stream.' });
  }
});

// -------------------------------------------------------------------
// STEP 1b: PROXY AUDIO STREAM (avoids YouTube IP-lock on direct URLs)
// -------------------------------------------------------------------
app.get('/api/proxy-audio', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url');

  try {
    const decodedUrl = Buffer.from(url, 'base64').toString('utf-8');
    const proto = decodedUrl.startsWith('https') ? https : require('http');

    const proxyReq = proto.get(decodedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://www.youtube.com',
      },
    }, (proxyRes) => {
      res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'audio/webm');
      res.setHeader('Accept-Ranges', 'bytes');
      if (proxyRes.headers['content-length']) {
        res.setHeader('Content-Length', proxyRes.headers['content-length']);
      }
      if (proxyRes.headers['content-range']) {
        res.setHeader('Content-Range', proxyRes.headers['content-range']);
      }
      res.status(proxyRes.statusCode);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error('Proxy error:', err.message);
      res.status(500).send('Proxy error');
    });

    req.on('close', () => proxyReq.destroy());
  } catch (e) {
    res.status(500).send('Invalid URL');
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

// Download latest yt-dlp first, then start the server
downloadLatestYtDlp().then((binaryPath) => {
  if (binaryPath) {
    youtubedl = require('youtube-dl-exec').create(binaryPath);
    console.log('Using freshly downloaded yt-dlp binary.');
  } else {
    console.log('Falling back to bundled yt-dlp binary.');
  }

  server.listen(PORT, () => {
    console.log(`VibeSync Backend running on http://localhost:${PORT}`);
  });
});