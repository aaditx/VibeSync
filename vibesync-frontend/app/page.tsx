"use client";

import { useState, useEffect, useRef } from "react";
import { io, Socket } from "socket.io-client";
import { Play, Pause, FastForward, Users, Link as LinkIcon } from "lucide-react";

// Connect to your backend
const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";
const socket: Socket = io(BACKEND_URL);

export default function VibeSyncApp() {
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [isHost, setIsHost] = useState(false);
  const [inRoom, setInRoom] = useState(false);
  
  const [roomCode, setRoomCode] = useState("");
  const [track, setTrack] = useState<{ title: string; audioUrl: string; thumbnail: string } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  
  const audioRef = useRef<HTMLAudioElement>(null);

  // --- SOCKET LISTENERS ---
  useEffect(() => {
    socket.on("user_joined", ({ userId }) => {
      console.log("User joined:", userId);
      // Host syncs the new user by sending current track & time if something is playing
      if (isHost && audioRef.current && track) {
        socket.emit("load_track", { roomCode, trackData: track });
        setTimeout(() => {
          socket.emit("seek", { roomCode, time: audioRef.current?.currentTime });
          if (!audioRef.current?.paused) socket.emit("play", { roomCode, time: audioRef.current?.currentTime });
        }, 500);
      }
    });

    socket.on("load_track", (trackData) => {
      setTrack(trackData);
    });

    socket.on("play", ({ time }) => {
      if (audioRef.current) {
        audioRef.current.currentTime = time;
        audioRef.current.play().catch((e) => console.log("Autoplay blocked, user interaction required:", e));
      }
    });

    socket.on("pause", ({ time }) => {
      if (audioRef.current) {
        audioRef.current.currentTime = time;
        audioRef.current.pause();
      }
    });

    socket.on("seek", ({ time }) => {
      if (audioRef.current) {
        audioRef.current.currentTime = time;
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
  }, [isHost, roomCode, track]);

  // --- LOBBY ACTIONS ---
  const handleCreateRoom = () => {
    socket.emit("create_room", (res: any) => {
      if (res.success) {
        setRoomCode(res.roomCode);
        setIsHost(res.isHost);
        setInRoom(true);
      }
    });
  };

  const handleJoinRoom = () => {
    if (!joinCode) return;
    socket.emit("join_room", joinCode, (res: any) => {
      if (res.success) {
        setRoomCode(res.roomCode);
        setIsHost(res.isHost);
        setInRoom(true);
      } else {
        alert(res.message);
      }
    });
  };

  // --- HOST AUDIO ACTIONS ---
  const handleExtractAudio = async () => {
    if (!youtubeUrl) return;
    setIsLoading(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/extract-audio`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: youtubeUrl }),
      });
      const data = await res.json();
      
      if (data.error) throw new Error(data.error);

      setTrack(data);
      socket.emit("load_track", { roomCode, trackData: data });
    } catch (error: any) {
      alert("Failed to load track: " + error.message);
    } finally {
      setIsLoading(false);
      setYoutubeUrl("");
    }
  };

  // Sync events triggered by the Host interacting with the HTML5 audio player
  const onPlay = () => isHost && socket.emit("play", { roomCode, time: audioRef.current?.currentTime });
  const onPause = () => isHost && socket.emit("pause", { roomCode, time: audioRef.current?.currentTime });
  const onSeek = () => isHost && socket.emit("seek", { roomCode, time: audioRef.current?.currentTime });

  // --- UI RENDERING ---
  return (
    <div className="min-h-screen bg-neutral-950 text-white font-mono p-6 flex flex-col items-center justify-center selection:bg-yellow-400 selection:text-black">
      
      {/* HEADER */}
      <h1 className="text-5xl font-black tracking-tighter uppercase mb-10 border-4 border-white p-4 shadow-[8px_8px_0_0_#ffffff] bg-black">
        Vibe<span className="text-yellow-400">Sync</span>
      </h1>

      {!inRoom ? (
        /* LOBBY UI */
        <div className="w-full max-w-md space-y-8 bg-neutral-900 border-4 border-white p-8 shadow-[8px_8px_0_0_#ffffff]">
          <div className="space-y-4">
            <h2 className="text-2xl font-bold uppercase border-b-2 border-white pb-2">Start a Session</h2>
            <button 
              onClick={handleCreateRoom}
              className="w-full bg-yellow-400 text-black font-bold text-xl uppercase py-4 border-4 border-black hover:bg-yellow-300 transition-colors shadow-[4px_4px_0_0_#ffffff] active:translate-x-1 active:translate-y-1 active:shadow-none"
            >
              Create Room
            </button>
          </div>

          <div className="space-y-4 pt-4">
            <h2 className="text-2xl font-bold uppercase border-b-2 border-white pb-2">Join a Session</h2>
            <div className="flex gap-2">
              <input 
                type="text" 
                placeholder="4-LETTER CODE" 
                maxLength={4}
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                className="w-full bg-black border-4 border-white p-3 text-xl font-bold uppercase focus:outline-none focus:border-yellow-400"
              />
              <button 
                onClick={handleJoinRoom}
                className="bg-white text-black font-bold uppercase px-6 border-4 border-black hover:bg-gray-200 transition-colors"
              >
                Join
              </button>
            </div>
          </div>
        </div>
      ) : (
        /* ROOM UI */
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

          {/* HOST CONTROLS */}
          {isHost && (
            <div className="flex gap-2 border-4 border-white p-4 bg-neutral-900 shadow-[4px_4px_0_0_#ffffff]">
              <LinkIcon className="mt-3 shrink-0" />
              <input 
                type="text" 
                placeholder="Paste YouTube Link..." 
                value={youtubeUrl}
                onChange={(e) => setYoutubeUrl(e.target.value)}
                className="w-full bg-black border-2 border-white p-2 text-sm focus:outline-none focus:border-yellow-400"
              />
              <button 
                onClick={handleExtractAudio}
                disabled={isLoading}
                className="bg-yellow-400 text-black font-bold uppercase px-4 border-2 border-black hover:bg-yellow-300 disabled:opacity-50"
              >
                {isLoading ? "Loading..." : "Load"}
              </button>
            </div>
          )}

          {/* MEDIA PLAYER */}
          {track ? (
            <div className="bg-black border-4 border-white p-6 shadow-[8px_8px_0_0_#ffffff] space-y-6">
              <div className="flex items-center gap-6">
                <img 
                  src={track.thumbnail} 
                  alt="Thumbnail" 
                  className="w-32 h-32 object-cover border-4 border-white shadow-[4px_4px_0_0_#ffffff]"
                />
                <div className="overflow-hidden">
                  <h3 className="text-xl font-bold truncate">{track.title}</h3>
                  <p className="text-yellow-400 uppercase text-sm mt-2 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
                    Live Sync Active
                  </p>
                </div>
              </div>

              {/* HTML5 AUDIO ELEMENT */}
              <div className="pt-4 border-t-2 border-neutral-800">
                <audio 
                  ref={audioRef}
                  src={track.audioUrl}
                  controls={isHost} // Only Host gets the native controls
                  onPlay={onPlay}
                  onPause={onPause}
                  onSeeked={onSeek}
                  className="w-full h-12"
                  autoPlay
                />
                
                {!isHost && (
                  <div className="mt-4 p-4 bg-neutral-900 border-2 border-dashed border-neutral-500 text-center text-sm text-neutral-400">
                    <p>You are a listener. The host controls the playback.</p>
                    <p className="mt-2 text-yellow-400">If audio doesn't play automatically, click anywhere on the page to allow autoplay.</p>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="bg-black border-4 border-neutral-800 p-12 text-center text-neutral-500 uppercase font-bold text-xl border-dashed">
              Waiting for host to load a track...
            </div>
          )}
        </div>
      )}
    </div>
  );
}