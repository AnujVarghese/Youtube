import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

const DEFAULT_VIDEO_ID = "jfKfPfyJRdk";
const CONTROL_ROLES = new Set(["host", "moderator"]);
const ROLE_LABELS = {
  host: "Host",
  moderator: "Moderator",
  participant: "Participant",
  viewer: "Viewer",
};

let youtubeApiPromise = null;

function getWebSocketUrl() {
  if (process.env.REACT_APP_WS_URL) {
    return process.env.REACT_APP_WS_URL;
  }

  const isLocalhost = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  if (isLocalhost) {
    return "ws://localhost:4000/ws";
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

function loadYouTubeApi() {
  if (window.YT?.Player) {
    return Promise.resolve(window.YT);
  }

  if (youtubeApiPromise) {
    return youtubeApiPromise;
  }

  youtubeApiPromise = new Promise((resolve) => {
    const previousReady = window.onYouTubeIframeAPIReady;

    window.onYouTubeIframeAPIReady = () => {
      if (typeof previousReady === "function") {
        previousReady();
      }
      resolve(window.YT);
    };

    if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      document.body.appendChild(script);
    }
  });

  return youtubeApiPromise;
}

function generateRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";

  for (let index = 0; index < 6; index += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }

  return code;
}

function formatTime(totalSeconds) {
  const safeSeconds = Math.max(0, Number(totalSeconds) || 0);
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = Math.floor(safeSeconds % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function defaultPlaybackState() {
  return {
    videoId: DEFAULT_VIDEO_ID,
    playState: "paused",
    currentTime: 0,
    updatedAt: Date.now(),
  };
}

function App() {
  const [screen, setScreen] = useState("lobby");
  const [username, setUsername] = useState(() => localStorage.getItem("watch-party-username") || "");
  const [roomInput, setRoomInput] = useState("");
  const [roomId, setRoomId] = useState("");
  const [currentUser, setCurrentUser] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [playback, setPlayback] = useState(defaultPlaybackState);
  const [connectionStatus, setConnectionStatus] = useState("Offline");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [videoDraft, setVideoDraft] = useState("");
  const [messages, setMessages] = useState([]);
  const [chatDraft, setChatDraft] = useState("");
  const [playerReady, setPlayerReady] = useState(false);
  const [playerTime, setPlayerTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const socketRef = useRef(null);
  const playerRef = useRef(null);
  const currentUserIdRef = useRef(null);
  const canControlRef = useRef(false);
  const sendEventRef = useRef(null);
  const playbackRef = useRef(playback);
  const applyingRemoteRef = useRef(false);
  const lastTickRef = useRef({ time: 0, at: Date.now() });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const inviteRoom = params.get("room");

    if (inviteRoom) {
      setRoomInput(inviteRoom.toUpperCase());
    }
  }, []);

  const currentParticipant = useMemo(
    () => participants.find((participant) => participant.userId === currentUser?.userId),
    [participants, currentUser],
  );
  const currentRole = currentParticipant?.role || currentUser?.role || "participant";
  const isHost = currentRole === "host";
  const canControl = CONTROL_ROLES.has(currentRole);
  const activeParticipantCount = participants.length;

  useEffect(() => {
    currentUserIdRef.current = currentUser?.userId || null;
  }, [currentUser]);

  useEffect(() => {
    canControlRef.current = canControl;
  }, [canControl]);

  useEffect(() => {
    playbackRef.current = playback;
  }, [playback]);

  const addNotice = useCallback((message) => {
    setNotice(message);
    window.clearTimeout(addNotice.timeout);
    addNotice.timeout = window.setTimeout(() => setNotice(""), 3200);
  }, []);

  const resetRoom = useCallback((closeSocket = true) => {
    const socket = socketRef.current;

    if (closeSocket && socket) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ event: "leave_room", payload: {} }));
      }
      socket.close();
    }

    socketRef.current = null;
    setScreen("lobby");
    setRoomId("");
    setCurrentUser(null);
    setParticipants([]);
    setPlayback(defaultPlaybackState());
    setMessages([]);
    setVideoDraft("");
    setChatDraft("");
    setPlayerReady(false);
    setConnectionStatus("Offline");
  }, []);

  const sendEvent = useCallback((event, payload = {}) => {
    const socket = socketRef.current;

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setError("The room connection is not open.");
      return;
    }

    socket.send(JSON.stringify({ event, payload }));
  }, []);

  useEffect(() => {
    sendEventRef.current = sendEvent;
  }, [sendEvent]);

  const handleServerEvent = useCallback(
    (event, payload = {}) => {
      switch (event) {
        case "joined_room":
          setRoomId(payload.roomId);
          setCurrentUser({
            userId: payload.userId,
            username: payload.username,
            role: payload.role,
          });
          setParticipants(payload.participants || []);
          setPlayback(payload.state || defaultPlaybackState());
          setScreen("room");
          setConnectionStatus("Connected");
          setError("");
          setMessages([]);
          addNotice(`Joined ${payload.roomId} as ${ROLE_LABELS[payload.role] || payload.role}.`);
          break;

        case "user_joined":
          setParticipants(payload.participants || []);
          if (payload.userId !== currentUserIdRef.current) {
            addNotice(`${payload.username} joined the room.`);
          }
          break;

        case "user_left":
          setParticipants(payload.participants || []);
          addNotice(`${payload.username} left the room.`);
          break;

        case "role_assigned":
          setParticipants(payload.participants || []);
          if (payload.userId === currentUserIdRef.current) {
            setCurrentUser((user) => (user ? { ...user, role: payload.role } : user));
            addNotice(`Your role is now ${ROLE_LABELS[payload.role] || payload.role}.`);
          } else {
            addNotice(`${payload.username} is now ${ROLE_LABELS[payload.role] || payload.role}.`);
          }
          break;

        case "participant_removed":
          setParticipants(payload.participants || []);
          addNotice(`${payload.username} was removed.`);
          break;

        case "removed_from_room":
          setError(payload.message || "You were removed from the room.");
          resetRoom(false);
          addNotice(payload.message || "You were removed from the room.");
          break;

        case "left_room":
          resetRoom(false);
          break;

        case "sync_state":
          if (payload.state) {
            setPlayback(payload.state);
          }
          if (payload.participants) {
            setParticipants(payload.participants);
          }
          if (payload.action === "change_video" && payload.by) {
            addNotice(`${payload.by} changed the video.`);
          }
          break;

        case "chat_message":
          setMessages((items) => [...items.slice(-60), payload]);
          break;

        case "error_message":
          setError(payload.message || "Something went wrong.");
          break;

        default:
          break;
      }
    },
    [addNotice, resetRoom],
  );

  const connectToRoom = useCallback(
    (targetRoomId) => {
      const cleanName = username.trim();
      const cleanRoom = targetRoomId.trim().toUpperCase();

      if (!cleanName) {
        setError("Enter your name first.");
        return;
      }

      if (!cleanRoom) {
        setError("Enter a room code.");
        return;
      }

      localStorage.setItem("watch-party-username", cleanName);
      setError("");
      setConnectionStatus("Connecting");

      if (socketRef.current) {
        socketRef.current.close();
      }

      const socket = new WebSocket(getWebSocketUrl());
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        setConnectionStatus("Joining");
        socket.send(
          JSON.stringify({
            event: "join_room",
            payload: {
              roomId: cleanRoom,
              username: cleanName,
            },
          }),
        );
      });

      socket.addEventListener("message", (message) => {
        try {
          const parsed = JSON.parse(message.data);
          handleServerEvent(parsed.event, parsed.payload);
        } catch {
          setError("Received an unreadable server message.");
        }
      });

      socket.addEventListener("error", () => {
        setConnectionStatus("Offline");
        setError("Could not reach the watch party server.");
      });

      socket.addEventListener("close", () => {
        setConnectionStatus("Offline");
      });
    },
    [handleServerEvent, username],
  );

  useEffect(() => {
    return () => {
      if (socketRef.current) {
        socketRef.current.close();
      }
    };
  }, []);

  useEffect(() => {
    if (screen !== "room") {
      return undefined;
    }

    let cancelled = false;
    setPlayerReady(false);

    loadYouTubeApi().then((YT) => {
      if (cancelled || playerRef.current) {
        return;
      }

      playerRef.current = new YT.Player("youtube-player", {
        videoId: playbackRef.current.videoId || DEFAULT_VIDEO_ID,
        playerVars: {
          autoplay: 0,
          controls: 0,
          modestbranding: 1,
          playsinline: 1,
          rel: 0,
        },
        events: {
          onReady: (event) => {
            setPlayerReady(true);
            event.target.cueVideoById({
              videoId: playbackRef.current.videoId || DEFAULT_VIDEO_ID,
              startSeconds: playbackRef.current.currentTime || 0,
            });
            sendEventRef.current?.("request_sync");
          },
          onStateChange: (event) => {
            if (applyingRemoteRef.current || !canControlRef.current) {
              return;
            }

            const player = playerRef.current;
            const time = player?.getCurrentTime?.() || 0;
            const playerState = window.YT?.PlayerState || {};

            if (event.data === playerState.PLAYING) {
              sendEventRef.current?.("play", { time });
            }

            if (event.data === playerState.PAUSED) {
              sendEventRef.current?.("pause", { time });
            }
          },
        },
      });
    });

    return () => {
      cancelled = true;
      setPlayerReady(false);
      if (playerRef.current?.destroy) {
        playerRef.current.destroy();
      }
      playerRef.current = null;
    };
  }, [screen]);

  useEffect(() => {
    const player = playerRef.current;

    if (screen !== "room" || !playerReady || !player || !playback.videoId) {
      return;
    }

    const targetTime = Math.max(0, Number(playback.currentTime) || 0);
    const currentVideoId = player.getVideoData?.()?.video_id;

    applyingRemoteRef.current = true;
    setPlayerTime(targetTime);

    const applyPlayState = () => {
      if (!playerRef.current) {
        return;
      }

      if (playback.playState === "playing") {
        playerRef.current.playVideo();
      } else {
        playerRef.current.pauseVideo();
      }
    };

    if (currentVideoId !== playback.videoId) {
      player.loadVideoById({
        videoId: playback.videoId,
        startSeconds: targetTime,
      });
      window.setTimeout(applyPlayState, 350);
    } else {
      const currentTime = player.getCurrentTime?.() || 0;
      if (Math.abs(currentTime - targetTime) > 1.2) {
        player.seekTo(targetTime, true);
      }
      applyPlayState();
    }

    window.setTimeout(() => {
      applyingRemoteRef.current = false;
    }, 900);
  }, [playback, playerReady, screen]);

  useEffect(() => {
    if (screen !== "room" || !playerReady) {
      return undefined;
    }

    const interval = window.setInterval(() => {
      const player = playerRef.current;
      if (!player?.getCurrentTime) {
        return;
      }

      const time = player.getCurrentTime();
      const videoDuration = player.getDuration?.() || 0;
      setPlayerTime(time);
      setDuration(videoDuration);

      const now = Date.now();
      const playerState = window.YT?.PlayerState || {};
      const isPlaying = player.getPlayerState?.() === playerState.PLAYING;
      const lastTick = lastTickRef.current;
      const expectedTime = lastTick.time + (isPlaying ? (now - lastTick.at) / 1000 : 0);

      if (
        canControlRef.current &&
        !applyingRemoteRef.current &&
        Number.isFinite(expectedTime) &&
        Math.abs(time - expectedTime) > 3
      ) {
        sendEventRef.current?.("seek", { time });
      }

      lastTickRef.current = { time, at: now };
    }, 1000);

    return () => window.clearInterval(interval);
  }, [playerReady, screen]);

  const createRoom = (event) => {
    event.preventDefault();
    connectToRoom(generateRoomCode());
  };

  const joinRoom = (event) => {
    event.preventDefault();
    connectToRoom(roomInput);
  };

  const copyInvite = async () => {
    const invite = `${window.location.origin}${window.location.pathname}?room=${roomId}`;

    try {
      await navigator.clipboard.writeText(invite);
      addNotice("Invite link copied.");
    } catch {
      setError(invite);
    }
  };

  const changeVideo = (event) => {
    event.preventDefault();
    if (!videoDraft.trim()) {
      setError("Paste a YouTube URL or video ID.");
      return;
    }
    sendEvent("change_video", { url: videoDraft.trim() });
    setVideoDraft("");
  };

  const sendChatMessage = (event) => {
    event.preventDefault();
    if (!chatDraft.trim()) {
      return;
    }
    sendEvent("chat_message", { message: chatDraft.trim() });
    setChatDraft("");
  };

  const requestSeek = (time) => {
    const safeTime = Math.max(0, Number(time) || 0);
    setPlayerTime(safeTime);
    sendEvent("seek", { time: safeTime });
  };

  const lobby = (
    <main className="lobby">
      <section className="lobby-panel">
        <div>
          <p className="eyebrow">Full Stack Task 1</p>
          <h1>YouTube Watch Party</h1>
          <p className="lobby-copy">
            Create a synchronized room, invite friends, and keep playback permissions under host
            control.
          </p>
        </div>

        <form className="lobby-form" onSubmit={joinRoom}>
          <label>
            Display name
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              maxLength={32}
              placeholder="Alex"
            />
          </label>

          <label>
            Room code
            <input
              value={roomInput}
              onChange={(event) => setRoomInput(event.target.value.toUpperCase())}
              maxLength={24}
              placeholder="ROOM42"
            />
          </label>

          <div className="button-row">
            <button className="primary-button" type="button" onClick={createRoom}>
              Create Room
            </button>
            <button className="secondary-button" type="submit">
              Join Room
            </button>
          </div>
        </form>
      </section>
    </main>
  );

  const room = (
    <main className="room">
      <header className="room-header">
        <div>
          <p className="eyebrow">Room {roomId}</p>
          <h1>YouTube Watch Party</h1>
        </div>
        <div className="header-actions">
          <button className="secondary-button compact" type="button" onClick={copyInvite}>
            Copy Invite
          </button>
          <button className="ghost-button compact" type="button" onClick={() => resetRoom(true)}>
            Leave
          </button>
        </div>
      </header>

      <section className="room-grid">
        <div className="watch-area">
          <div className="player-frame">
            <div id="youtube-player" />
            {!playerReady && <div className="player-loading">Loading player</div>}
          </div>

          <div className="control-strip">
            <div className="time-block">
              <span>{formatTime(playerTime)}</span>
              <input
                aria-label="Seek video"
                type="range"
                min="0"
                max={Math.max(1, Math.floor(duration || playerTime || 1))}
                value={Math.min(Math.floor(playerTime), Math.max(1, Math.floor(duration || playerTime || 1)))}
                disabled={!canControl || !playerReady}
                onChange={(event) => requestSeek(event.target.value)}
              />
              <span>{formatTime(duration)}</span>
            </div>

            <div className="playback-buttons">
              <button
                className="primary-button compact"
                type="button"
                disabled={!canControl || !playerReady}
                onClick={() => sendEvent("play", { time: playerTime })}
              >
                Play
              </button>
              <button
                className="secondary-button compact"
                type="button"
                disabled={!canControl || !playerReady}
                onClick={() => sendEvent("pause", { time: playerTime })}
              >
                Pause
              </button>
              <button
                className="secondary-button compact"
                type="button"
                disabled={!canControl || !playerReady}
                onClick={() => requestSeek(0)}
              >
                Restart
              </button>
            </div>
          </div>

          <form className="video-form" onSubmit={changeVideo}>
            <input
              value={videoDraft}
              onChange={(event) => setVideoDraft(event.target.value)}
              placeholder="Paste YouTube URL or video ID"
              disabled={!canControl}
            />
            <button className="primary-button compact" type="submit" disabled={!canControl}>
              Change Video
            </button>
          </form>
        </div>

        <aside className="side-panel">
          <section className="status-panel">
            <div>
              <span className="status-dot" />
              <span>{connectionStatus}</span>
            </div>
            <strong>{ROLE_LABELS[currentRole] || currentRole}</strong>
            <span>{activeParticipantCount} in room</span>
          </section>

          <section className="participants-panel">
            <div className="panel-heading">
              <h2>Participants</h2>
              <span>{activeParticipantCount}</span>
            </div>

            <div className="participant-list">
              {participants.map((participant) => (
                <div className="participant-row" key={participant.userId}>
                  <div className="participant-main">
                    <strong>{participant.username}</strong>
                    <span>{ROLE_LABELS[participant.role] || participant.role}</span>
                  </div>

                  {isHost && participant.role !== "host" && (
                    <div className="role-tools">
                      <select
                        aria-label={`Role for ${participant.username}`}
                        value={participant.role}
                        onChange={(event) =>
                          sendEvent("assign_role", {
                            userId: participant.userId,
                            role: event.target.value,
                          })
                        }
                      >
                        <option value="participant">Participant</option>
                        <option value="moderator">Moderator</option>
                        <option value="viewer">Viewer</option>
                      </select>
                      <button
                        className="ghost-button square"
                        type="button"
                        title="Transfer host"
                        onClick={() => sendEvent("transfer_host", { userId: participant.userId })}
                      >
                        H
                      </button>
                      <button
                        className="danger-button square"
                        type="button"
                        title="Remove participant"
                        onClick={() => sendEvent("remove_participant", { userId: participant.userId })}
                      >
                        X
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>

          <section className="chat-panel">
            <div className="panel-heading">
              <h2>Chat</h2>
              <span>{messages.length}</span>
            </div>

            <div className="chat-messages">
              {messages.length === 0 && <p className="empty-state">No messages yet.</p>}
              {messages.map((message) => (
                <div className="chat-message" key={message.id}>
                  <strong>{message.username}</strong>
                  <span>{message.message}</span>
                </div>
              ))}
            </div>

            <form className="chat-form" onSubmit={sendChatMessage}>
              <input
                value={chatDraft}
                onChange={(event) => setChatDraft(event.target.value)}
                maxLength={280}
                placeholder="Message"
              />
              <button className="secondary-button compact" type="submit">
                Send
              </button>
            </form>
          </section>
        </aside>
      </section>
    </main>
  );

  return (
    <div className="app-shell">
      {screen === "room" ? room : lobby}

      {(notice || error) && (
        <div className={`toast ${error ? "toast-error" : ""}`}>
          <span>{error || notice}</span>
          {error && (
            <button type="button" onClick={() => setError("")}>
              Dismiss
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default App;
