# YouTube Watch Party System

Full-stack watch party MVP for synchronized YouTube playback with room codes, WebSocket sync,
participant roles, host-only moderation, and chat.

## Stack

- Frontend: React with Create React App
- Backend: Node.js HTTP server with a dependency-free WebSocket implementation
- Video: YouTube IFrame Player API
- Storage: In-memory rooms for the MVP

## Local Setup

Open two terminals from the project root.

Terminal 1:

```bash
cd backend
npm start
```

Terminal 2:

```bash
cd frontend
npm start
```

Then open `http://localhost:3000`.

The frontend connects to `ws://localhost:4000/ws` by default. For deployment, set:

```bash
REACT_APP_WS_URL=wss://your-backend-domain/ws
```

## How It Works

The backend keeps an in-memory `Room` for each room code. A room owns its participant list,
current video ID, play/pause state, and current time. Clients send WebSocket events such as
`play`, `pause`, `seek`, `change_video`, `assign_role`, and `remove_participant`.

Every privileged event is validated on the backend:

- `host` and `moderator` can control playback and change videos.
- `participant` and `viewer` can watch and chat.
- Only `host` can assign roles, remove participants, or transfer host.

When the server accepts an event, it broadcasts the updated room state to every client. Each
browser applies that state to its YouTube IFrame player, keeping playback synchronized.

## Features

- Create a watch room with a shareable code.
- Join an existing room as a participant.
- Synchronized YouTube play, pause, seek, and video changes.
- Participant list with live role updates.
- Host role assignment, participant removal, and host transfer.
- Backend-side permission enforcement.
- Basic room chat.

## Deployment

This workspace has not been deployed yet. A good first deployment target is Render or Railway
because both can run a long-lived Node WebSocket server. Deploy `backend` as the web service,
deploy `frontend` as a static React app, and set `REACT_APP_WS_URL` to the public backend
WebSocket URL.

Live URL: add your deployed URL here.
