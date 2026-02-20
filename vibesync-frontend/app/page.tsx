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
  const [displayName, setDisplayName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [isHost, setIsHost] = useState(false);
  const [inRoom, setInRoom] = useState(false);
  const [roomCode, setRoomCode] = useState("");
  const [roomUsers, setRoomUsers] = useState<{ name: string; isHost: boolean }[]>([]);

  const [track, setTrack] = useState<Track | null>(null);
  const [queue, setQueue] = useState<Track[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [needsInteraction, setNeedsInteraction] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  const [chatMessages, setChatMessages] = useState<{ name: string; text: string; time: number }[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [activeReactions, setActiveReactions] = useState<{ id: number; emoji: string; x: number }[]>([]);
  const [requests, setRequests] = useState<(Track & { requestedBy: string })[]>([]);
  const [guestSearchQuery, setGuestSearchQuery] = useState("");
  const [guestSearchResults, setGuestSearchResults] = useState<SearchResult[]>([]);
  const [isGuestSearching, setIsGuestSearching] = useState(false);

  const playerRef = useRef<any>(null);
  const isSyncingRef = useRef(false);
  const timeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isPlayingRef = useRef(false);
  const pendingPlayRef = useRef<number | null>(null);
  const wasPlayingOnHideRef = useRef(false);
  // Tracks if user has ever interacted — suppresses re-showing the unlock banner on queue advance
  const hasInteractedRef = useRef(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const reactionIdRef = useRef(0);

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
      setCurrentTime(0);
      setDuration(0);
      // Only show unlock banner if user hasn't interacted yet
      if (!hasInteractedRef.current) setNeedsInteraction(true);
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

    socket.on("room_users", (users: { name: string; isHost: boolean }[]) => {
      setRoomUsers(users);
    });

    socket.on("queue_update", (q: Track[]) => {
      setQueue(q);
    });

    socket.on("chat_message", (msg: { name: string; text: string; time: number }) => {
      setChatMessages(prev => [...prev, msg]);
    });

    socket.on("reaction", ({ emoji }: { emoji: string }) => {
      const id = ++reactionIdRef.current;
      const x = 5 + Math.random() * 80;
      setActiveReactions(prev => [...prev, { id, emoji, x }]);
      setTimeout(() => setActiveReactions(prev => prev.filter(r => r.id !== id)), 2500);
    });

    socket.on("requests_update", (reqs: (Track & { requestedBy: string })[]) => {
      setRequests(reqs);
    });

    return () => {
      socket.off("user_joined");
      socket.off("load_track");
      socket.off("play");
      socket.off("pause");
      socket.off("seek");
      socket.off("host_transferred");
      socket.off("room_users");
      socket.off("queue_update");
      socket.off("chat_message");
      socket.off("reaction");
      socket.off("requests_update");
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

  // Auto-scroll chat to latest message
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  // Auto-fill join code from shareable URL (?join=XXXX)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const joinParam = params.get('join');
    if (joinParam) setJoinCode(joinParam.slice(0, 4).toUpperCase());
  }, []);

  // --- LOBBY ---
  const handleCreateRoom = () => {
    if (!socket.connected) { alert("Not connected to server. Please wait and try again."); return; }
    const name = displayName.trim() || "Host";
    socket.emit("create_room", { name }, (res: any) => {
      if (res.success) { setRoomCode(res.roomCode); setIsHost(res.isHost); setInRoom(true); }
    });
  };

  const handleJoinRoom = () => {
    if (!joinCode) return;
    if (!socket.connected) { alert("Not connected to server. Retrying connection..."); socket.connect(); return; }
    const name = displayName.trim() || "Listener";
    socket.emit("join_room", { code: joinCode, name }, (res: any) => {
      if (res.success) {
        setRoomCode(res.roomCode);
        setIsHost(res.isHost);
        setInRoom(true);
        if (res.currentTrack) { setTrack(res.currentTrack); setNeedsInteraction(true); }
        if (res.queue) setQueue(res.queue);
        if (res.messages) setChatMessages(res.messages);
        if (res.requests) setRequests(res.requests);
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
    setQueue([]);
    setSearchResults([]);
    setSearchQuery("");
    setIsPlaying(false);
    setNeedsInteraction(false);
    socket.emit("load_track", { roomCode, trackData });
  };

  const handleAddToQueue = (result: SearchResult) => {
    const trackData: Track = { videoId: result.videoId, title: result.title, thumbnail: result.thumbnail, channel: result.channel };
    socket.emit("add_to_queue", { roomCode, trackData });
    setSearchResults([]);
    setSearchQuery("");
  };

  const handleRemoveFromQueue = (index: number) => {
    socket.emit("remove_from_queue", { roomCode, index });
  };

  // --- CHAT ---
  const handleSendMessage = () => {
    const text = chatInput.trim();
    if (!text) return;
    socket.emit("send_message", { roomCode, text });
    setChatInput("");
  };

  // --- REACTIONS ---
  const handleSendReaction = (emoji: string) => {
    socket.emit("send_reaction", { roomCode, emoji });
  };

  // --- GUEST SEARCH & REQUESTS ---
  const handleGuestSearch = async () => {
    if (!guestSearchQuery.trim()) return;
    setIsGuestSearching(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/search?q=${encodeURIComponent(guestSearchQuery)}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setGuestSearchResults(data);
    } catch (e: any) {
      alert("Search failed: " + e.message);
    } finally {
      setIsGuestSearching(false);
    }
  };

  const handleRequestTrack = (result: SearchResult) => {
    const trackData: Track = { videoId: result.videoId, title: result.title, thumbnail: result.thumbnail, channel: result.channel };
    socket.emit("request_track", { roomCode, trackData });
    setGuestSearchResults([]);
    setGuestSearchQuery("");
    alert("Request sent to host!");
  };

  const handleApproveRequest = (index: number, addToQueue: boolean) => {
    socket.emit("approve_request", { roomCode, index, addToQueue });
  };

  const handleRejectRequest = (index: number) => {
    socket.emit("reject_request", { roomCode, index });
  };

  // --- HOST CONTROLS ---
  const handlePlay = () => {
    if (!playerRef.current) return;
    const time = playerRef.current.getCurrentTime();
    // Bug fix: set isSyncingRef BEFORE playVideo() to prevent onStateChange
    // from double-emitting play back to the room
    isSyncingRef.current = true;
    setIsPlaying(true);
    playerRef.current.playVideo();
    socket.emit("play", { roomCode, time });
    setTimeout(() => { isSyncingRef.current = false; }, 500);
  };

  const handlePause = () => {
    if (!playerRef.current) return;
    const time = playerRef.current.getCurrentTime();
    // Bug fix: same as handlePlay — prevent double-emit via onStateChange
    isSyncingRef.current = true;
    setIsPlaying(false);
    playerRef.current.pauseVideo();
    socket.emit("pause", { roomCode, time });
    setTimeout(() => { isSyncingRef.current = false; }, 500);
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
    const YT_PLAYING = 1, YT_PAUSED = 2, YT_ENDED = 0;
    if (e.data === YT_PLAYING) {
      setIsPlaying(true);
      setDuration(e.target.getDuration() || 0);
      if (isHost) socket.emit("play", { roomCode, time: e.target.getCurrentTime() });
    } else if (e.data === YT_PAUSED) {
      if (document.hidden) return;
      setIsPlaying(false);
      if (isHost) socket.emit("pause", { roomCode, time: e.target.getCurrentTime() });
    } else if (e.data === YT_ENDED) {
      // Host signals end so server can advance the queue for everyone
      if (isHost) socket.emit("track_ended", { roomCode });
    }
  };

  const handleGuestUnlock = () => {
    hasInteractedRef.current = true;
    if (playerRef.current) {
      playerRef.current.playVideo();
      setNeedsInteraction(false);
    } else {
      pendingPlayRef.current = 0;
      setNeedsInteraction(false);
    }
  };

  // Bug fix: guard against NaN when duration/currentTime not yet loaded
  const formatTime = (s: number) => {
    s = Math.max(0, s || 0);
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  };

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

      {/* FLOATING REACTIONS OVERLAY */}
      {activeReactions.map(r => (
        <div key={r.id} className="reaction-float" style={{ position: "fixed", bottom: "15%", left: `${r.x}%`, zIndex: 9999, fontSize: "2.5rem", pointerEvents: "none", userSelect: "none" }}>
          {r.emoji}
        </div>
      ))}

      {/* HEADER */}
      <h1 className="text-5xl font-black tracking-tighter uppercase mb-10 border-4 border-white p-4 shadow-[8px_8px_0_0_#ffffff] bg-black">
        Vibe<span className="text-yellow-400">Sync</span>
      </h1>

      {!inRoom ? (
        /* LOBBY */
        <div className="w-full max-w-md space-y-8 bg-neutral-900 border-4 border-white p-8 shadow-[8px_8px_0_0_#ffffff]">
          <div className="space-y-4">
            <h2 className="text-2xl font-bold uppercase border-b-2 border-white pb-2">Your Name</h2>
            <input type="text" placeholder="Enter your name..." maxLength={20} value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full bg-black border-4 border-white p-3 text-lg font-bold focus:outline-none focus:border-yellow-400" />
          </div>
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
            <div className="flex items-center gap-2 flex-wrap">
              <Users className="text-yellow-400 shrink-0" />
              <span className="text-xl font-bold uppercase">Room: {roomCode}</span>
              <button onClick={() => navigator.clipboard.writeText(roomCode)}
                className="text-neutral-400 hover:text-yellow-400 text-xs font-bold uppercase border border-neutral-700 px-2 py-1 hover:border-yellow-400">
                Copy Code
              </button>
              <button onClick={() => navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}?join=${roomCode}`)}
                className="text-neutral-400 hover:text-yellow-400 text-xs font-bold uppercase border border-neutral-700 px-2 py-1 hover:border-yellow-400">
                Share Link
              </button>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={() => setIsChatOpen(o => !o)}
                className={`text-xs font-bold uppercase px-3 py-1 border-2 transition-colors ${isChatOpen ? 'border-yellow-400 text-yellow-400' : 'border-neutral-600 text-neutral-400 hover:border-white hover:text-white'}`}>
                💬 Chat
              </button>
              <div className="px-3 py-1 bg-yellow-400 text-black font-bold uppercase text-sm border-2 border-black">
                {isHost ? "Host" : "Listener"}
              </div>
            </div>
          </div>

          {/* ACTIVE USERS */}
          {roomUsers.length > 0 && (
            <div className="bg-neutral-900 border-4 border-white p-4 shadow-[4px_4px_0_0_#ffffff]">
              <h3 className="text-xs font-bold uppercase text-neutral-400 mb-3 tracking-widest">In this room — {roomUsers.length}</h3>
              <div className="flex flex-wrap gap-2">
                {roomUsers.map((u, i) => (
                  <div key={i} className={`flex items-center gap-2 px-3 py-1.5 border-2 text-sm font-bold ${
                    u.isHost ? 'border-yellow-400 text-yellow-400' : 'border-neutral-600 text-white'
                  }`}>
                    <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse shrink-0" />
                    {u.name}
                    {u.isHost && <span className="text-xs opacity-70 ml-1">HOST</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* REACTIONS BAR */}
          <div className="bg-neutral-900 border-4 border-white p-3 shadow-[4px_4px_0_0_#ffffff]">
            <p className="text-xs font-bold uppercase text-neutral-400 mb-2 tracking-widest">React</p>
            <div className="flex gap-2">
              {["🔥", "❤️", "😂", "🎵", "👏", "💀"].map(emoji => (
                <button key={emoji} onClick={() => handleSendReaction(emoji)}
                  className="text-2xl hover:scale-125 transition-transform active:scale-95">
                  {emoji}
                </button>
              ))}
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
                    <div key={r.videoId} className="flex items-center gap-3 p-3 border-b border-neutral-800 hover:bg-neutral-800">
                      <img src={r.thumbnail} alt="" className="w-16 h-12 object-cover border-2 border-neutral-700 shrink-0" />
                      <div className="overflow-hidden flex-1">
                        <p className="font-bold text-sm truncate">{r.title}</p>
                        <p className="text-yellow-400 text-xs">{r.channel}</p>
                      </div>
                      <div className="flex flex-col gap-1 shrink-0">
                        <button onClick={() => handleSelectTrack(r)}
                          className="bg-yellow-400 text-black font-bold text-xs uppercase px-2 py-1 border border-black hover:bg-yellow-300">
                          ▶ Play
                        </button>
                        <button onClick={() => handleAddToQueue(r)}
                          className="bg-neutral-700 text-white font-bold text-xs uppercase px-2 py-1 border border-neutral-500 hover:bg-neutral-600">
                          + Queue
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* GUEST SEARCH & REQUESTS */}
          {!isHost && (
            <div className="bg-neutral-900 border-4 border-white shadow-[4px_4px_0_0_#ffffff]">
              <div className="flex gap-2 p-4">
                <Search className="mt-2 shrink-0 text-neutral-400" />
                <input type="text" placeholder="Request a song..."
                  value={guestSearchQuery}
                  onChange={(e) => setGuestSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleGuestSearch()}
                  className="w-full bg-black border-2 border-white p-2 text-sm focus:outline-none focus:border-yellow-400" />
                <button onClick={handleGuestSearch} disabled={isGuestSearching}
                  className="bg-neutral-700 text-white font-bold uppercase px-4 border-2 border-neutral-500 hover:bg-neutral-600 disabled:opacity-50 shrink-0">
                  {isGuestSearching ? "..." : "Search"}
                </button>
              </div>
              {guestSearchResults.length > 0 && (
                <div className="border-t-2 border-white max-h-60 overflow-y-auto">
                  {guestSearchResults.map((r) => (
                    <div key={r.videoId} className="flex items-center gap-3 p-3 border-b border-neutral-800 hover:bg-neutral-800">
                      <img src={r.thumbnail} alt="" className="w-14 h-10 object-cover border border-neutral-700 shrink-0" />
                      <div className="overflow-hidden flex-1">
                        <p className="font-bold text-sm truncate">{r.title}</p>
                        <p className="text-yellow-400 text-xs">{r.channel}</p>
                      </div>
                      <button onClick={() => handleRequestTrack(r)}
                        className="bg-neutral-700 text-white font-bold text-xs uppercase px-2 py-1 border border-neutral-500 hover:bg-neutral-600 shrink-0">
                        📩 Request
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* HOST: PENDING TRACK REQUESTS */}
          {isHost && requests.length > 0 && (
            <div className="bg-neutral-900 border-4 border-yellow-400 shadow-[4px_4px_0_0_#facc15]">
              <h3 className="text-xs font-bold uppercase text-yellow-400 tracking-widest p-4 pb-2">
                📩 Track Requests — {requests.length}
              </h3>
              <div className="divide-y divide-neutral-800">
                {requests.map((req, i) => (
                  <div key={i} className="flex items-center gap-3 p-3">
                    <img src={req.thumbnail} alt="" className="w-12 h-9 object-cover border border-neutral-700 shrink-0" />
                    <div className="overflow-hidden flex-1">
                      <p className="font-bold text-sm truncate">{req.title}</p>
                      <p className="text-neutral-400 text-xs">by {req.requestedBy}</p>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <button onClick={() => handleApproveRequest(i, false)}
                        className="bg-yellow-400 text-black font-bold text-xs uppercase px-2 py-1 border border-black hover:bg-yellow-300">
                        ▶ Play
                      </button>
                      <button onClick={() => handleApproveRequest(i, true)}
                        className="bg-neutral-700 text-white font-bold text-xs uppercase px-2 py-1 border border-neutral-500 hover:bg-neutral-600">
                        + Queue
                      </button>
                      <button onClick={() => handleRejectRequest(i)}
                        className="text-neutral-500 hover:text-white font-bold text-lg px-2">
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>
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
                    {queue.length > 0 && (
                      <button onClick={() => socket.emit("track_ended", { roomCode })}
                        className="bg-neutral-700 text-white border-2 border-neutral-500 px-3 py-2 text-sm font-bold uppercase hover:bg-neutral-600">
                        Next ⏭
                      </button>
                    )}
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

          {/* QUEUE */}
          {queue.length > 0 && (
            <div className="bg-neutral-900 border-4 border-white shadow-[4px_4px_0_0_#ffffff]">
              <h3 className="text-xs font-bold uppercase text-neutral-400 tracking-widest p-4 pb-2">Up Next — {queue.length}</h3>
              <div className="divide-y divide-neutral-800">
                {queue.map((q, i) => (
                  <div key={i} className="flex items-center gap-3 p-3">
                    <span className="text-neutral-500 font-bold text-sm w-5 shrink-0">{i + 1}</span>
                    <img src={q.thumbnail} alt="" className="w-12 h-9 object-cover border border-neutral-700 shrink-0" />
                    <div className="overflow-hidden flex-1">
                      <p className="font-bold text-sm truncate">{q.title}</p>
                      {q.channel && <p className="text-yellow-400 text-xs">{q.channel}</p>}
                    </div>
                    {isHost && (
                      <button onClick={() => handleRemoveFromQueue(i)}
                        className="text-neutral-500 hover:text-white font-bold text-lg shrink-0 px-2">
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* CHAT PANEL */}
          {isChatOpen && (
            <div className="bg-neutral-900 border-4 border-white shadow-[4px_4px_0_0_#ffffff]">
              <h3 className="text-xs font-bold uppercase text-neutral-400 tracking-widest p-4 pb-2 border-b border-neutral-800">💬 Chat</h3>
              <div className="h-56 overflow-y-auto p-3 space-y-2">
                {chatMessages.length === 0 && (
                  <p className="text-neutral-600 text-xs text-center uppercase mt-4">No messages yet. Say something!</p>
                )}
                {chatMessages.map((msg, i) => (
                  <div key={i} className="text-sm">
                    <span className="font-bold text-yellow-400">{msg.name}: </span>
                    <span className="text-white">{msg.text}</span>
                  </div>
                ))}
                <div ref={chatEndRef} />
              </div>
              <div className="flex gap-2 p-3 border-t border-neutral-800">
                <input
                  type="text"
                  placeholder="Type a message..."
                  maxLength={200}
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSendMessage()}
                  className="flex-1 bg-black border-2 border-white p-2 text-sm focus:outline-none focus:border-yellow-400"
                />
                <button onClick={handleSendMessage}
                  className="bg-yellow-400 text-black font-bold uppercase px-4 border-2 border-black hover:bg-yellow-300 shrink-0">
                  Send
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
