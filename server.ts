/**
 * GO-CHAT - Phase 2 WebSocket Signalling & Full-Stack Server
 * 
 * Features:
 * - Real-time WebSocket room management
 * - WebRTC signalling relay (offer/answer/ICE)
 * - Room ownership tracking (first user becomes Owner, passed upon departure)
 * - In-memory ephemeral room destruction when last user leaves
 * - Heartbeat/ping checking for dead connection pruning
 * - Integration with Vite middleware in dev and static files in prod
 */

import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface Member {
  id: string;
  name: string;
  isOwner: boolean;
  ws: WebSocket;
  isAlive: boolean;
}

interface Room {
  roomNumber: string;
  ownerId: string;
  members: Map<string, Member>;
  createdAt: number;
}

// In-memory rooms repository (strictly ephemeral, no permanent storage)
const rooms = new Map<string, Room>();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Socket tracking map: WebSocket -> { peerId, roomNumber }
const socketMetadata = new WeakMap<WebSocket, { peerId: string; roomNumber?: string }>();

// API status & health endpoints for Google Cloud Run
app.get(['/health', '/status'], (_req, res) => {
  res.status(200).json({ status: 'healthy', totalActiveRooms: rooms.size });
});

app.get('/api/status', (_req, res) => {
  const activeRooms = Array.from(rooms.values()).map(r => ({
    room: r.roomNumber,
    memberCount: r.members.size,
    ownerId: r.ownerId
  }));
  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    totalActiveRooms: rooms.size,
    activeRooms
  });
});

// Helper: safe JSON send
function send(ws: WebSocket, payload: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

// Handle client leaving a room
function handleLeaveRoom(ws: WebSocket) {
  const meta = socketMetadata.get(ws);
  if (!meta || !meta.roomNumber) return;

  const room = rooms.get(meta.roomNumber);
  if (!room) {
    meta.roomNumber = undefined;
    return;
  }

  const leavingMember = room.members.get(meta.peerId);
  const leavingName = leavingMember ? leavingMember.name : 'A member';
  const wasOwner = leavingMember ? leavingMember.isOwner : false;

  // Remove member from room
  room.members.delete(meta.peerId);
  meta.roomNumber = undefined;

  // If no members remain, destroy room and ephemeral state
  if (room.members.size === 0) {
    rooms.delete(room.roomNumber);
    console.log(`[GO-CHAT] Room #${room.roomNumber} destroyed (last user left).`);
    return;
  }

  // If the owner left, reassign ownership to the earliest remaining member
  let newOwnerId = room.ownerId;
  if (wasOwner) {
    const nextOwner = room.members.values().next().value as Member;
    if (nextOwner) {
      nextOwner.isOwner = true;
      room.ownerId = nextOwner.id;
      newOwnerId = nextOwner.id;
      console.log(`[GO-CHAT] New owner for Room #${room.roomNumber}: ${nextOwner.name} (${nextOwner.id})`);
    }
  }

  // Broadcast user-left to remaining room members
  for (const member of room.members.values()) {
    send(member.ws, {
      type: 'user-left',
      id: meta.peerId,
      name: leavingName,
      newOwnerId: newOwnerId,
      memberCount: room.members.size
    });
  }
}

// WebSocket Connection Handling
wss.on('connection', (ws: WebSocket) => {
  const peerId = crypto.randomUUID();
  socketMetadata.set(ws, { peerId });
  
  // Custom heartbeat tracking
  (ws as any).isAlive = true;
  ws.on('pong', () => {
    (ws as any).isAlive = true;
  });

  // Acknowledge connection
  send(ws, {
    type: 'connected',
    peerId: peerId
  });

  ws.on('message', (data: Buffer | string) => {
    try {
      const msg = JSON.parse(data.toString());
      const meta = socketMetadata.get(ws);
      if (!meta) return;

      switch (msg.type) {
        case 'ping': {
          (ws as any).isAlive = true;
          send(ws, { type: 'pong' });
          break;
        }

        case 'join-room': {
          const roomNumber = String(msg.room || '').trim();
          const name = String(msg.name || '').trim();

          if (!roomNumber || !name) {
            send(ws, { type: 'error', message: 'Name and Room number are required.' });
            return;
          }

          // Leave current room if already in one
          if (meta.roomNumber) {
            handleLeaveRoom(ws);
          }

          meta.roomNumber = roomNumber;

          let room = rooms.get(roomNumber);
          const isFirstUser = !room || room.members.size === 0;

          if (!room) {
            room = {
              roomNumber,
              ownerId: peerId,
              members: new Map<string, Member>(),
              createdAt: Date.now()
            };
            rooms.set(roomNumber, room);
            console.log(`[GO-CHAT] Room #${roomNumber} created by ${name} (Owner).`);
          }

          const isOwner = isFirstUser || room.ownerId === peerId;
          const member: Member = {
            id: peerId,
            name,
            isOwner,
            ws,
            isAlive: true
          };

          room.members.set(peerId, member);

          // 1. Send confirmation + current member snapshot to joining user
          const memberList = Array.from(room.members.values()).map(m => ({
            id: m.id,
            name: m.name,
            isOwner: m.isOwner
          }));

          send(ws, {
            type: 'room-joined',
            peerId,
            room: roomNumber,
            isOwner,
            members: memberList
          });

          // 2. Broadcast user-joined to all other members in the room
          for (const otherMember of room.members.values()) {
            if (otherMember.id !== peerId) {
              send(otherMember.ws, {
                type: 'user-joined',
                user: {
                  id: peerId,
                  name,
                  isOwner
                },
                memberCount: room.members.size
              });
            }
          }

          break;
        }

        case 'leave-room': {
          handleLeaveRoom(ws);
          send(ws, { type: 'room-left' });
          break;
        }

        case 'signal': {
          // WebRTC signalling: offer, answer, or ice-candidate relay
          const { targetId, signal } = msg;
          if (!targetId || !signal || !meta.roomNumber) return;

          const room = rooms.get(meta.roomNumber);
          if (!room) return;

          const targetMember = room.members.get(targetId);
          if (targetMember) {
            send(targetMember.ws, {
              type: 'signal',
              senderId: peerId,
              signal
            });
          }
          break;
        }

        case 'chat-message': {
          // Room-wide message delivery
          if (!meta.roomNumber) return;
          const room = rooms.get(meta.roomNumber);
          if (!room) return;

          const sender = room.members.get(peerId);
          const senderName = sender ? sender.name : 'Anonymous';
          const text = String(msg.text || '').trim();
          if (!text) return;

          // Broadcast to all other members in this room
          for (const member of room.members.values()) {
            if (member.id !== peerId) {
              send(member.ws, {
                type: 'chat-message',
                id: msg.id || ('msg-' + Date.now()),
                senderId: peerId,
                senderName,
                text,
                timestamp: msg.timestamp || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              });
            }
          }
          break;
        }

        default:
          break;
      }
    } catch (err) {
      console.error('[GO-CHAT] Message handling error:', err);
    }
  });

  ws.on('close', () => {
    handleLeaveRoom(ws);
  });

  ws.on('error', (err) => {
    console.error('[GO-CHAT] WebSocket error for peer', peerId, err);
    handleLeaveRoom(ws);
  });
});

// Periodic heartbeat / ping interval to detect stale/disconnected clients
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws: WebSocket) => {
    if ((ws as any).isAlive === false) {
      console.log('[GO-CHAT] Terminating unresponsive socket.');
      handleLeaveRoom(ws);
      return ws.terminate();
    }
    (ws as any).isAlive = false;
    ws.ping();
  });
}, 25000);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

// --- Server & Vite Setup ---
async function startServer() {
  const isProduction = process.env.NODE_ENV === 'production';
  const PORT = parseInt(process.env.PORT || '3000', 10);

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: process.env.DISABLE_HMR !== 'true' },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[GO-CHAT] Server running on http://0.0.0.0:${PORT}`);
    console.log(`[GO-CHAT] WebSocket Signalling ready on ws://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('[GO-CHAT] Failed to start server:', err);
  process.exit(1);
});
