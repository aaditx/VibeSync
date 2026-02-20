const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');
const play = require('play-dl');

// In-memory cache: videoId -> { filePath, title, thumbnail, size }
const audioCache = new Map();

// -------------------------------------------------------------------
// AUTO-DOWNLOAD LATEST yt-dlp BINARY ON STARTUP
// -------------------------------------------------------------------
const isWin = process.platform === 'win32';
const ytDlpFilename = isWin ? 'yt-dlp.exe' : 'yt-dlp';
const ytDlpUrl = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ytDlpFilename}`;
const ytDlpPath = path.join(os.tmpdir(), ytDlpFilename);
let ytDlpReady = false;

function downloadLatestYtDlp() {
  return new Promise((resolve) => {
    console.log(`Downloading latest yt-dlp binary (${ytDlpFilename})...`);
    const file = fs.createWriteStream(ytDlpPath);

    function doGet(targetUrl) {
      https.get(targetUrl, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return doGet(res.headers.location);
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          try { fs.chmodSync(ytDlpPath, '755'); } catch (e) {}
          console.log('yt-dlp downloaded successfully.');
          resolve(true);
        });
      }).on('error', (err) => {
        console.error('yt-dlp download error:', err.message);
        resolve(false);
      });
    }
    doGet(ytDlpUrl);
  });
}

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

  if (!ytDlpReady) {
    return res.status(503).json({ error: 'Server is still starting up, please try again in a moment.' });
  }

  try {
    // Get metadata via play-dl (title, thumbnail)
    const info = await play.video_info(url);
    const details = info.video_details;
    const videoId = details.id;
    const title = details.title || 'Unknown Title';
    const thumbnail = details.thumbnails?.[details.thumbnails.length - 1]?.url || '';

    // Serve from cache if already downloaded
    if (audioCache.has(videoId) && fs.existsSync(audioCache.get(videoId).filePath)) {
      console.log(`Cache hit: ${videoId}`);
      return res.json({ title, audioUrl: `/api/audio/${videoId}`, thumbnail });
    }

    // Download audio to temp file via yt-dlp
    const filePath = path.join(os.tmpdir(), `vs_${videoId}.m4a`);
    console.log(`Downloading audio for: ${title}`);

    const args = [
      url,
      '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
      '-o', filePath,
      '--no-part',
      '--no-playlist',
      '--quiet',
      '--no-warnings',
    ];
    if (process.env.YOUTUBE_COOKIES) {
      const cookiePath = path.join(os.tmpdir(), 'cookies.txt');
      if (!fs.existsSync(cookiePath)) fs.writeFileSync(cookiePath, process.env.YOUTUBE_COOKIES);
      args.push('--cookies', cookiePath);
    }

    await new Promise((resolve, reject) => {
      execFile(ytDlpPath, args, { timeout: 120000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve();
      });
    });

    // yt-dlp may choose a different extension; find the actual file
    const actualFile = [filePath, filePath.replace('.m4a', '.webm'), filePath.replace('.m4a', '.opus')]
      .find(f => fs.existsSync(f)) || filePath;

    const { size } = fs.statSync(actualFile);
    const ext = path.extname(actualFile).slice(1) || 'm4a';
    audioCache.set(videoId, { filePath: actualFile, ext, size });
    console.log(`Audio ready: ${videoId} (${(size / 1024 / 1024).toFixed(1)} MB, .${ext})`);

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

  const { filePath, ext, size } = cached;
  const mimeTypes = { m4a: 'audio/mp4', webm: 'audio/webm', opus: 'audio/ogg', mp3: 'audio/mpeg' };
  const contentType = mimeTypes[ext] || 'audio/webm';
  const range = req.headers.range;

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);
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

// Download yt-dlp binary first, then start server
downloadLatestYtDlp().then((ok) => {
  ytDlpReady = ok;
  if (!ok) console.warn('yt-dlp unavailable — audio extraction will fail.');
  server.listen(PORT, () => {
    console.log(`VibeSync Backend running on http://localhost:${PORT}`);
  });
});