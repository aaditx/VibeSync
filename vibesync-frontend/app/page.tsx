"use client";

import { useState, useEffect, useRef } from "react";
import { io, Socket } from "socket.io-client";
import { Play, Pause, Search, Users, Music } from "lucide-react";
import YouTube from "react-youtube";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";
const socket: Socket = io(BACKEND_URL);

type Track = { videoId: string; title: string; thumbnail: string; channel?: string };
type SearchResult = { videoId: string; title: string; channel: string; thumbnail: string };

export default function VibeSyncApp() {
  const [joinCode, setJoinCode] = useState("");
  const [isHost, setIsHost] = useState(false);
  const [inRoom, setInRoom] = useState(false);
  const [roomCode, setRoomCode] = useState("");

  const [track, setTrack] = useState<Track | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [needsInteraction, setNeedsInteraction] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  const playerRef = useRef<any>(null);
  const isSyncingRef = useRef(false);
  const timeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isPlayingRef = useRef(false);
  // Stores a play command that arrived before the player was ready
  const pendingPlayRef = useRef<number | null>(null);
  // Tracks whether we were playing before the tab was hidden (YouTube auto-pauses on hide)
  const wasPlayingOnHideRef = useRef(false);

  // --- SOCKET LISTENERS ---
  useEffect(() => {
    socket.on("user_joined", () => {
      if (isHost && playerRef.current && track) {
        const time = playerRef.current.getCurrentTime();
        socket.emit("load_track", { roomCode, trackData: track });
        setTimeout(() => {
          socket.emit("seek", { roomCode, time });
          if (isPlaying) socket.emit("play", { roomCode, time });
        }, 500);
      }
    });

    socket.on("load_track", (trackData: Track) => {
      setTrack(trackData);
      setNeedsInteraction(true);
      setIsPlaying(false);
    });

    socket.on("play", ({ time }: { time: number }) => {
      if (playerRef.current) {
        isSyncingRef.current = true;
        playerRef.current.seekTo(time, true);
        playerRef.current.playVideo();
        setIsPlaying(true);
        setTimeout(() => { isSyncingRef.current = false; }, 500);
      } else {
        // Player not ready yet — store and apply once onPlayerReady fires
        pendingPlayRef.current = time;
      }
    });

    socket.on("pause", ({ time }: { time: number }) => {
      if (playerRef.current) {
        isSyncingRef.current = true;
        playerRef.current.seekTo(time, true);
        playerRef.current.pauseVideo();
        setIsPlaying(false);
        setTimeout(() => { isSyncingRef.current = false; }, 500);
      }
    });

    socket.on("seek", ({ time }: { time: number }) => {
      if (playerRef.current) {
        isSyncingRef.current = true;
        playerRef.current.seekTo(time, true);
        setTimeout(() => { isSyncingRef.current = false; }, 500);
      }
    });

    socket.on("host_transferred", () => {
      setIsHost(true);
      alert("The host left. You are now the host!");
    });

    return () => {
      socket.off("user_joined");
      socket.off("load_track");
      socket.off("play");
      socket.off("pause");
      socket.off("seek");
      socket.off("host_transferred");
    };
  }, [isHost, roomCode, track, isPlaying]);

  // Keep isPlayingRef in sync for use inside event listeners
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

  // Poll current time for seek slider
  useEffect(() => {
    if (timeIntervalRef.current) clearInterval(timeIntervalRef.current);
    if (isPlaying && playerRef.current) {
      timeIntervalRef.current = setInterval(() => {
        if (playerRef.current) setCurrentTime(playerRef.current.getCurrentTime() || 0);
      }, 500);
    }
    return () => { if (timeIntervalRef.current) clearInterval(timeIntervalRef.current); };
  }, [isPlaying]);

  // --- MEDIA SESSION (OS media controls + background play hint) ---
  useEffect(() => {
    if (!track || !('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.channel || 'VibeSync',
      artwork: [{ src: track.thumbnail, sizes: '480x360', type: 'image/jpeg' }],
    });
    navigator.mediaSession.setActionHandler('play', () => {
      if (isHost) handlePlay();
    });
    navigator.mediaSession.setActionHandler('pause', () => {
      if (isHost) handlePause();
    });
    return () => {
      navigator.mediaSession.setActionHandler('play', null);
      navigator.mediaSession.setActionHandler('pause', null);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track, isHost]);

  // Update MediaSession playback state
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
  }, [isPlaying]);

  // --- VISIBILITY CHANGE: resume playback if tab returns while we should be playing ---
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        // Snapshot playing state before YouTube auto-pauses the iframe
        wasPlayingOnHideRef.current = isPlayingRef.current;
      } else if (document.visibilityState === 'visible' && wasPlayingOnHideRef.current && playerRef.current) {
        wasPlayingOnHideRef.current = false;
        // Retry resume — iframe compositor re-activation can take varying time
        [200, 600, 1200].forEach((delay) => {
          setTimeout(() => {
            try {
              if (playerRef.current?.getPlayerState?.() !== 1) {
                playerRef.current?.playVideo();
              }
            } catch { /* ignore */ }
          }, delay);
        });
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  // --- LOBBY ---
  const handleCreateRoom = () => {
    if (!socket.connected) { alert("Not connected to server. Please wait and try again."); return; }
    socket.emit("create_room", (res: any) => {
      if (res.success) { setRoomCode(res.roomCode); setIsHost(res.isHost); setInRoom(true); }
    });
  };

  const handleJoinRoom = () => {
    if (!joinCode) return;
    if (!socket.connected) { alert("Not connected to server. Retrying connection..."); socket.connect(); return; }
    socket.emit("join_room", joinCode, (res: any) => {
      if (res.success) {
        setRoomCode(res.roomCode);
        setIsHost(res.isHost);
        setInRoom(true);
        if (res.currentTrack) { setTrack(res.currentTrack); setNeedsInteraction(true); }
      } else alert(res.message);
    });
  };

  // --- SEARCH ---
  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/search?q=${encodeURIComponent(searchQuery)}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setSearchResults(data);
    } catch (e: any) {
      alert("Search failed: " + e.message);
    } finally {
      setIsSearching(false);
    }
  };

  const handleSelectTrack = (result: SearchResult) => {
    const trackData: Track = { videoId: result.videoId, title: result.title, thumbnail: result.thumbnail, channel: result.channel };
    setTrack(trackData);
    setSearchResults([]);
    setSearchQuery("");
    setIsPlaying(false);
    setNeedsInteraction(false);
    socket.emit("load_track", { roomCode, trackData });
  };

  // --- HOST CONTROLS ---
  const handlePlay = () => {
    if (!playerRef.current) return;
    const time = playerRef.current.getCurrentTime();
    playerRef.current.playVideo();
    socket.emit("play", { roomCode, time });
  };

  const handlePause = () => {
    if (!playerRef.current) return;
    const time = playerRef.current.getCurrentTime();
    playerRef.current.pauseVideo();
    socket.emit("pause", { roomCode, time });
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = Number(e.target.value);
    if (playerRef.current) {
      playerRef.current.seekTo(time, true);
      setCurrentTime(time);
      socket.emit("seek", { roomCode, time });
    }
  };

  // --- YOUTUBE PLAYER EVENTS ---
  const onPlayerReady = (e: any) => {
    playerRef.current = e.target;
    setDuration(e.target.getDuration() || 0);
    // Apply any play command that arrived before the player was ready
    if (pendingPlayRef.current !== null) {
      const time = pendingPlayRef.current;
      pendingPlayRef.current = null;
      isSyncingRef.current = true;
      e.target.seekTo(time, true);
      e.target.playVideo();
      setIsPlaying(true);
      setTimeout(() => { isSyncingRef.current = false; }, 500);
    }
  };

  const onStateChange = (e: any) => {
    if (isSyncingRef.current) return;
    const YT_PLAYING = 1, YT_PAUSED = 2;
    if (e.data === YT_PLAYING) {
      setIsPlaying(true);
      setDuration(e.target.getDuration() || 0);
      if (isHost) socket.emit("play", { roomCode, time: e.target.getCurrentTime() });
    } else if (e.data === YT_PAUSED) {
      // YouTube auto-pauses when tab goes hidden — don't treat this as a real pause
      if (document.hidden) return;
      setIsPlaying(false);
      if (isHost) socket.emit("pause", { roomCode, time: e.target.getCurrentTime() });
    }
  };

  const handleGuestUnlock = () => {
    if (playerRef.current) {
      playerRef.current.playVideo();
      setNeedsInteraction(false);
    } else {
      // Player still loading — mark pending so onPlayerReady will auto-play
      pendingPlayRef.current = 0;
      setNeedsInteraction(false);
    }
  };

  const formatTime = (s: number) =>
    `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  return (
    <div className="min-h-screen bg-neutral-950 text-white font-mono p-6 flex flex-col items-center justify-center selection:bg-yellow-400 selection:text-black">

      {/* HIDDEN YOUTUBE PLAYER — opacity:0.001 keeps compositor active; no zIndex:-1 which would kill audio */}
      {track && (
        <div style={{ position: "fixed", bottom: 0, right: 0, width: 320, height: 180, opacity: 0.001, pointerEvents: "none", zIndex: 0 }}>
          <YouTube
            videoId={track.videoId}
            opts={{ width: "320", height: "180", playerVars: { autoplay: 0, controls: 0, rel: 0, modestbranding: 1, iv_load_policy: 3, playsinline: 1 } }}
            onReady={onPlayerReady}
            onStateChange={onStateChange}
          />
        </div>
      )}

      {/* HEADER */}
      <h1 className="text-5xl font-black tracking-tighter uppercase mb-10 border-4 border-white p-4 shadow-[8px_8px_0_0_#ffffff] bg-black">
        Vibe<span className="text-yellow-400">Sync</span>
      </h1>

      {!inRoom ? (
        /* LOBBY */
        <div className="w-full max-w-md space-y-8 bg-neutral-900 border-4 border-white p-8 shadow-[8px_8px_0_0_#ffffff]">
          <div className="space-y-4">
            <h2 className="text-2xl font-bold uppercase border-b-2 border-white pb-2">Start a Session</h2>
            <button onClick={handleCreateRoom} className="w-full bg-yellow-400 text-black font-bold text-xl uppercase py-4 border-4 border-black hover:bg-yellow-300 transition-colors shadow-[4px_4px_0_0_#ffffff] active:translate-x-1 active:translate-y-1 active:shadow-none">
              Create Room
            </button>
          </div>
          <div className="space-y-4 pt-4">
            <h2 className="text-2xl font-bold uppercase border-b-2 border-white pb-2">Join a Session</h2>
            <div className="flex gap-2">
              <input type="text" placeholder="4-LETTER CODE" maxLength={4} value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === "Enter" && handleJoinRoom()}
                className="w-full bg-black border-4 border-white p-3 text-xl font-bold uppercase focus:outline-none focus:border-yellow-400" />
              <button onClick={handleJoinRoom} className="bg-white text-black font-bold uppercase px-6 border-4 border-black hover:bg-gray-200 transition-colors">
                Join
              </button>
            </div>
          </div>
        </div>
      ) : (
        /* ROOM */
        <div className="w-full max-w-2xl space-y-6">

          {/* ROOM INFO BAR */}
          <div className="flex items-center justify-between bg-black border-4 border-white p-4 shadow-[4px_4px_0_0_#ffffff]">
            <div className="flex items-center gap-3">
              <Users className="text-yellow-400" />
              <span className="text-xl font-bold uppercase">Room: {roomCode}</span>
            </div>
            <div className="px-3 py-1 bg-yellow-400 text-black font-bold uppercase text-sm border-2 border-black">
              {isHost ? "Host" : "Listener"}
            </div>
          </div>

          {/* HOST SEARCH */}
          {isHost && (
            <div className="bg-neutral-900 border-4 border-white shadow-[4px_4px_0_0_#ffffff]">
              <div className="flex gap-2 p-4">
                <Search className="mt-2 shrink-0 text-yellow-400" />
                <input type="text" placeholder="Search for a song..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                  className="w-full bg-black border-2 border-white p-2 text-sm focus:outline-none focus:border-yellow-400" />
                <button onClick={handleSearch} disabled={isSearching}
                  className="bg-yellow-400 text-black font-bold uppercase px-4 border-2 border-black hover:bg-yellow-300 disabled:opacity-50 shrink-0">
                  {isSearching ? "..." : "Search"}
                </button>
              </div>
              {searchResults.length > 0 && (
                <div className="border-t-2 border-white max-h-72 overflow-y-auto">
                  {searchResults.map((r) => (
                    <button key={r.videoId} onClick={() => handleSelectTrack(r)}
                      className="w-full flex items-center gap-3 p-3 hover:bg-neutral-800 border-b border-neutral-800 text-left">
                      <img src={r.thumbnail} alt="" className="w-16 h-12 object-cover border-2 border-neutral-700 shrink-0" />
                      <div className="overflow-hidden">
                        <p className="font-bold text-sm truncate">{r.title}</p>
                        <p className="text-yellow-400 text-xs">{r.channel}</p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* NOW PLAYING */}
          {track ? (
            <div className="bg-black border-4 border-white p-6 shadow-[8px_8px_0_0_#ffffff] space-y-6">
              <div className="flex items-center gap-6">
                <img src={track.thumbnail} alt="Thumbnail" className="w-32 h-24 object-cover border-4 border-white shadow-[4px_4px_0_0_#ffffff]" />
                <div className="overflow-hidden flex-1">
                  <h3 className="text-xl font-bold truncate">{track.title}</h3>
                  {track.channel && <p className="text-neutral-400 text-sm mt-1">{track.channel}</p>}
                  <p className="text-yellow-400 uppercase text-sm mt-2 flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${isPlaying ? "bg-green-500 animate-pulse" : "bg-neutral-500"}`} />
                    {isPlaying ? "Live Sync Active" : "Paused"}
                  </p>
                </div>
              </div>

              {/* HOST CONTROLS */}
              {isHost && (
                <div className="pt-4 border-t-2 border-neutral-800 space-y-3">
                  <div className="flex items-center gap-4">
                    <button onClick={isPlaying ? handlePause : handlePlay}
                      className="bg-yellow-400 text-black border-2 border-black p-3 hover:bg-yellow-300 shadow-[2px_2px_0_0_#ffffff]">
                      {isPlaying ? <Pause size={20} /> : <Play size={20} />}
                    </button>
                    <span className="text-sm text-neutral-400">{formatTime(currentTime)} / {formatTime(duration)}</span>
                  </div>
                  <input type="range" min={0} max={duration || 100} value={currentTime}
                    onChange={handleSeek} className="w-full accent-yellow-400 cursor-pointer" />
                </div>
              )}

              {/* GUEST: unlock autoplay */}
              {!isHost && needsInteraction && (
                <div className="pt-4 border-t-2 border-neutral-800">
                  <button onClick={handleGuestUnlock}
                    className="w-full bg-yellow-400 text-black font-bold uppercase py-3 border-2 border-black hover:bg-yellow-300 shadow-[2px_2px_0_0_#ffffff]">
                    ▶ Click to Start Listening
                  </button>
                </div>
              )}
              {!isHost && !needsInteraction && (
                <div className="pt-4 border-t-2 border-neutral-800 text-center text-sm text-neutral-400 uppercase">
                  Listening — host controls playback
                </div>
              )}
            </div>
          ) : (
            <div className="bg-black border-4 border-neutral-800 p-12 text-center text-neutral-500 uppercase font-bold text-xl border-dashed">
              <Music className="mx-auto mb-4 opacity-30" size={48} />
              {isHost ? "Search for a song above to get started" : "Waiting for host to load a track..."}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
