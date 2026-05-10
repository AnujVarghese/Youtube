const http = require("http");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || "0.0.0.0";
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFAULT_VIDEO_ID = "jfKfPfyJRdk";

const ROLES = {
  HOST: "host",
  MODERATOR: "moderator",
  PARTICIPANT: "participant",
  VIEWER: "viewer",
};

const CONTROL_ROLES = new Set([ROLES.HOST, ROLES.MODERATOR]);
const ASSIGNABLE_ROLES = new Set([
  ROLES.MODERATOR,
  ROLES.PARTICIPANT,
  ROLES.VIEWER,
]);

function createId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function cleanRoomId(roomId) {
  return String(roomId || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "")
    .slice(0, 24);
}

function cleanUsername(username) {
  return String(username || "Guest").trim().replace(/\s+/g, " ").slice(0, 32) || "Guest";
}

function extractYouTubeVideoId(input) {
  const value = String(input || "").trim();

  if (/^[A-Za-z0-9_-]{11}$/.test(value)) {
    return value;
  }

  try {
    const url = new URL(value);

    if (url.searchParams.get("v") && /^[A-Za-z0-9_-]{11}$/.test(url.searchParams.get("v"))) {
      return url.searchParams.get("v");
    }

    const pathParts = url.pathname.split("/").filter(Boolean);
    const candidates = [
      url.hostname.includes("youtu.be") ? pathParts[0] : null,
      pathParts[pathParts.indexOf("embed") + 1],
      pathParts[pathParts.indexOf("shorts") + 1],
      pathParts[pathParts.indexOf("live") + 1],
    ].filter(Boolean);

    const match = candidates.find((candidate) => /^[A-Za-z0-9_-]{11}$/.test(candidate));
    return match || null;
  } catch {
    return null;
  }
}

function adjustedState(state) {
  const elapsed = state.playState === "playing" ? (Date.now() - state.updatedAt) / 1000 : 0;

  return {
    videoId: state.videoId,
    playState: state.playState,
    currentTime: Math.max(0, state.currentTime + elapsed),
    updatedAt: Date.now(),
  };
}

class Participant {
  constructor({ username, role, connection }) {
    this.userId = createId("user");
    this.username = username;
    this.role = role;
    this.connection = connection;
  }

  toJSON() {
    return {
      userId: this.userId,
      username: this.username,
      role: this.role,
    };
  }
}

class Room {
  constructor(roomId) {
    this.roomId = roomId;
    this.participants = new Map();
    this.state = {
      videoId: DEFAULT_VIDEO_ID,
      playState: "paused",
      currentTime: 0,
      updatedAt: Date.now(),
    };
  }

  get size() {
    return this.participants.size;
  }

  getParticipants() {
    return Array.from(this.participants.values()).map((participant) => participant.toJSON());
  }

  getState() {
    return adjustedState(this.state);
  }

  addParticipant(connection, username) {
    const role = this.participants.size === 0 ? ROLES.HOST : ROLES.PARTICIPANT;
    const participant = new Participant({ username, role, connection });

    this.participants.set(participant.userId, participant);
    connection.roomId = this.roomId;
    connection.userId = participant.userId;

    return participant;
  }

  removeParticipant(userId) {
    const participant = this.participants.get(userId);
    if (!participant) {
      return { participant: null, promoted: null };
    }

    const wasHost = participant.role === ROLES.HOST;
    this.participants.delete(userId);

    let promoted = null;
    if (wasHost && this.participants.size > 0) {
      promoted =
        Array.from(this.participants.values()).find((item) => item.role === ROLES.MODERATOR) ||
        Array.from(this.participants.values())[0];
      promoted.role = ROLES.HOST;
    }

    return { participant, promoted };
  }

  findParticipant(userId) {
    return this.participants.get(userId);
  }

  broadcast(event, payload = {}, exceptUserId = null) {
    for (const participant of this.participants.values()) {
      if (participant.userId !== exceptUserId) {
        participant.connection.send(event, payload);
      }
    }
  }

  setPlayback(partialState) {
    this.state = {
      ...this.state,
      ...partialState,
      updatedAt: Date.now(),
    };
  }
}

class WebSocketConnection {
  constructor(socket, request, app) {
    this.socket = socket;
    this.request = request;
    this.app = app;
    this.buffer = Buffer.alloc(0);
    this.roomId = null;
    this.userId = null;

    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("close", () => this.app.handleDisconnect(this));
    socket.on("error", () => this.app.handleDisconnect(this));
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length > 0) {
      const frame = this.readFrame(this.buffer);
      if (!frame) {
        return;
      }

      this.buffer = this.buffer.slice(frame.frameLength);

      if (frame.opcode === 0x8) {
        this.close();
        return;
      }

      if (frame.opcode === 0x9) {
        this.writeFrame(frame.payload, 0xA);
        continue;
      }

      if (frame.opcode !== 0x1) {
        continue;
      }

      try {
        const message = JSON.parse(frame.payload.toString("utf8"));
        this.app.handleClientEvent(this, message.event, message.payload || {});
      } catch {
        this.sendError("Malformed message.");
      }
    }
  }

  readFrame(buffer) {
    if (buffer.length < 2) {
      return null;
    }

    const firstByte = buffer[0];
    const secondByte = buffer[1];
    const opcode = firstByte & 0x0F;
    const masked = Boolean(secondByte & 0x80);
    let payloadLength = secondByte & 0x7F;
    let offset = 2;

    if (payloadLength === 126) {
      if (buffer.length < offset + 2) {
        return null;
      }
      payloadLength = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLength === 127) {
      if (buffer.length < offset + 8) {
        return null;
      }
      const bigLength = buffer.readBigUInt64BE(offset);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        this.close();
        return null;
      }
      payloadLength = Number(bigLength);
      offset += 8;
    }

    const maskLength = masked ? 4 : 0;
    if (buffer.length < offset + maskLength + payloadLength) {
      return null;
    }

    let payload = buffer.slice(offset + maskLength, offset + maskLength + payloadLength);

    if (masked) {
      const mask = buffer.slice(offset, offset + 4);
      payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    }

    return {
      opcode,
      payload,
      frameLength: offset + maskLength + payloadLength,
    };
  }

  writeFrame(payload, opcode = 0x1) {
    if (this.socket.destroyed) {
      return;
    }

    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
    let header;

    if (body.length < 126) {
      header = Buffer.alloc(2);
      header[1] = body.length;
    } else if (body.length < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(body.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(body.length), 2);
    }

    header[0] = 0x80 | opcode;
    this.socket.write(Buffer.concat([header, body]));
  }

  send(event, payload = {}) {
    this.writeFrame(JSON.stringify({ event, payload }));
  }

  sendError(message, event = null) {
    this.send("error_message", { message, event });
  }

  close() {
    if (!this.socket.destroyed) {
      this.socket.end();
    }
  }
}

class WatchPartyServer {
  constructor() {
    this.rooms = new Map();
    this.connections = new Set();
    this.httpServer = http.createServer((request, response) => this.handleHttp(request, response));
    this.httpServer.on("upgrade", (request, socket) => this.handleUpgrade(request, socket));
  }

  listen(port, host) {
    this.httpServer.listen(port, host, () => {
      console.log(`Watch Party server listening on http://${host}:${port}`);
    });
  }

  handleHttp(request, response) {
    if (request.url === "/health") {
      this.sendJson(response, 200, {
        ok: true,
        rooms: this.rooms.size,
        participants: Array.from(this.rooms.values()).reduce((total, room) => total + room.size, 0),
      });
      return;
    }

    if (request.url === "/api/rooms") {
      this.sendJson(response, 200, {
        rooms: Array.from(this.rooms.values()).map((room) => ({
          roomId: room.roomId,
          participants: room.size,
          state: room.getState(),
        })),
      });
      return;
    }

    this.sendJson(response, 200, {
      name: "YouTube Watch Party WebSocket backend",
      websocket: "/ws",
      health: "/health",
    });
  }

  sendJson(response, statusCode, body) {
    response.writeHead(statusCode, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    response.end(JSON.stringify(body, null, 2));
  }

  handleUpgrade(request, socket) {
    if (!request.url.startsWith("/ws")) {
      socket.destroy();
      return;
    }

    const key = request.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }

    const accept = crypto
      .createHash("sha1")
      .update(`${key}${WEBSOCKET_GUID}`)
      .digest("base64");

    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n"),
    );

    const connection = new WebSocketConnection(socket, request, this);
    this.connections.add(connection);
  }

  getOrCreateRoom(roomId) {
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, new Room(roomId));
    }

    return this.rooms.get(roomId);
  }

  getConnectionContext(connection) {
    const room = this.rooms.get(connection.roomId);
    const participant = room ? room.findParticipant(connection.userId) : null;
    return { room, participant };
  }

  requireParticipant(connection, event) {
    const context = this.getConnectionContext(connection);
    if (!context.room || !context.participant) {
      connection.sendError("Join a room before sending room events.", event);
      return null;
    }

    return context;
  }

  requireControl(connection, event) {
    const context = this.requireParticipant(connection, event);
    if (!context) {
      return null;
    }

    if (!CONTROL_ROLES.has(context.participant.role)) {
      connection.sendError("You do not have permission to control playback.", event);
      return null;
    }

    return context;
  }

  requireHost(connection, event) {
    const context = this.requireParticipant(connection, event);
    if (!context) {
      return null;
    }

    if (context.participant.role !== ROLES.HOST) {
      connection.sendError("Only the host can do that.", event);
      return null;
    }

    return context;
  }

  handleClientEvent(connection, event, payload) {
    switch (event) {
      case "join_room":
        this.joinRoom(connection, payload);
        break;
      case "leave_room":
        this.leaveRoom(connection);
        break;
      case "request_sync":
        this.sendSync(connection);
        break;
      case "play":
        this.updatePlayback(connection, event, { playState: "playing", currentTime: payload.time });
        break;
      case "pause":
        this.updatePlayback(connection, event, { playState: "paused", currentTime: payload.time });
        break;
      case "seek":
        this.updatePlayback(connection, event, { currentTime: payload.time });
        break;
      case "change_video":
        this.changeVideo(connection, payload);
        break;
      case "assign_role":
        this.assignRole(connection, payload);
        break;
      case "remove_participant":
        this.removeParticipant(connection, payload);
        break;
      case "transfer_host":
        this.transferHost(connection, payload);
        break;
      case "chat_message":
        this.chatMessage(connection, payload);
        break;
      default:
        connection.sendError("Unknown event.", event);
    }
  }

  joinRoom(connection, payload) {
    const roomId = cleanRoomId(payload.roomId) || cleanRoomId(createId("ROOM"));
    const username = cleanUsername(payload.username);

    if (connection.roomId) {
      this.leaveRoom(connection, false);
    }

    const room = this.getOrCreateRoom(roomId);
    const participant = room.addParticipant(connection, username);
    const participants = room.getParticipants();

    connection.send("joined_room", {
      roomId,
      userId: participant.userId,
      username: participant.username,
      role: participant.role,
      participants,
      state: room.getState(),
    });

    room.broadcast("user_joined", {
      username: participant.username,
      userId: participant.userId,
      role: participant.role,
      participants,
    });
  }

  leaveRoom(connection, notifySelf = true) {
    const room = this.rooms.get(connection.roomId);
    if (!room || !connection.userId) {
      return;
    }

    const { participant, promoted } = room.removeParticipant(connection.userId);
    connection.roomId = null;
    connection.userId = null;

    if (notifySelf) {
      connection.send("left_room", {});
    }

    if (room.size === 0) {
      this.rooms.delete(room.roomId);
      return;
    }

    room.broadcast("user_left", {
      username: participant.username,
      userId: participant.userId,
      participants: room.getParticipants(),
    });

    if (promoted) {
      room.broadcast("role_assigned", {
        userId: promoted.userId,
        username: promoted.username,
        role: promoted.role,
        participants: room.getParticipants(),
      });
    }
  }

  handleDisconnect(connection) {
    if (!this.connections.has(connection)) {
      return;
    }

    this.connections.delete(connection);
    this.leaveRoom(connection, false);
  }

  sendSync(connection) {
    const context = this.requireParticipant(connection, "request_sync");
    if (!context) {
      return;
    }

    connection.send("sync_state", {
      state: context.room.getState(),
      participants: context.room.getParticipants(),
    });
  }

  updatePlayback(connection, event, patch) {
    const context = this.requireControl(connection, event);
    if (!context) {
      return;
    }

    const currentTime = Number.isFinite(Number(patch.currentTime))
      ? Math.max(0, Number(patch.currentTime))
      : context.room.getState().currentTime;

    context.room.setPlayback({
      ...patch,
      currentTime,
    });

    context.room.broadcast("sync_state", {
      action: event,
      by: context.participant.username,
      state: context.room.getState(),
    });
  }

  changeVideo(connection, payload) {
    const context = this.requireControl(connection, "change_video");
    if (!context) {
      return;
    }

    const videoId = extractYouTubeVideoId(payload.videoId || payload.url);
    if (!videoId) {
      connection.sendError("Paste a valid YouTube URL or 11 character video ID.", "change_video");
      return;
    }

    context.room.setPlayback({
      videoId,
      playState: "paused",
      currentTime: 0,
    });

    context.room.broadcast("sync_state", {
      action: "change_video",
      by: context.participant.username,
      state: context.room.getState(),
    });
  }

  assignRole(connection, payload) {
    const context = this.requireHost(connection, "assign_role");
    if (!context) {
      return;
    }

    const role = String(payload.role || "").toLowerCase();
    const target = context.room.findParticipant(payload.userId);

    if (!target) {
      connection.sendError("Participant not found.", "assign_role");
      return;
    }

    if (target.role === ROLES.HOST) {
      connection.sendError("Use transfer host to change the host.", "assign_role");
      return;
    }

    if (!ASSIGNABLE_ROLES.has(role)) {
      connection.sendError("That role is not assignable.", "assign_role");
      return;
    }

    target.role = role;

    context.room.broadcast("role_assigned", {
      userId: target.userId,
      username: target.username,
      role: target.role,
      participants: context.room.getParticipants(),
    });
  }

  removeParticipant(connection, payload) {
    const context = this.requireHost(connection, "remove_participant");
    if (!context) {
      return;
    }

    const target = context.room.findParticipant(payload.userId);

    if (!target) {
      connection.sendError("Participant not found.", "remove_participant");
      return;
    }

    if (target.userId === context.participant.userId) {
      connection.sendError("The host cannot remove themselves.", "remove_participant");
      return;
    }

    target.connection.send("removed_from_room", {
      roomId: context.room.roomId,
      message: "You were removed by the host.",
    });

    const { participant } = context.room.removeParticipant(target.userId);
    target.connection.roomId = null;
    target.connection.userId = null;
    target.connection.close();

    context.room.broadcast("participant_removed", {
      userId: participant.userId,
      username: participant.username,
      participants: context.room.getParticipants(),
    });
  }

  transferHost(connection, payload) {
    const context = this.requireHost(connection, "transfer_host");
    if (!context) {
      return;
    }

    const target = context.room.findParticipant(payload.userId);

    if (!target) {
      connection.sendError("Participant not found.", "transfer_host");
      return;
    }

    if (target.userId === context.participant.userId) {
      connection.sendError("You are already the host.", "transfer_host");
      return;
    }

    context.participant.role = ROLES.MODERATOR;
    target.role = ROLES.HOST;

    context.room.broadcast("role_assigned", {
      userId: target.userId,
      username: target.username,
      role: target.role,
      participants: context.room.getParticipants(),
    });
  }

  chatMessage(connection, payload) {
    const context = this.requireParticipant(connection, "chat_message");
    if (!context) {
      return;
    }

    const message = String(payload.message || "").trim().slice(0, 280);
    if (!message) {
      return;
    }

    context.room.broadcast("chat_message", {
      id: createId("msg"),
      userId: context.participant.userId,
      username: context.participant.username,
      role: context.participant.role,
      message,
      sentAt: new Date().toISOString(),
    });
  }
}

new WatchPartyServer().listen(PORT, HOST);
