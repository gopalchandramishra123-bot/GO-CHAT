/**
 * GO-CHAT - Dedicated Node.js WebSocket Signalling Server
 * Production-ready for Google Cloud Run, Render, Railway, or standalone Node.js.
 * 
 * - Listens on 0.0.0.0 and process.env.PORT (defaults to 8080)
 * - Ephemeral in-memory room management (Zero database)
 * - Room ownership (first user becomes Owner, re-assigned on departure)
 * - Room destruction when empty
 * - WebRTC SDP & ICE signalling relay
 * - WebSocket fallback message broadcast
 * - Heartbeat ping/pong for Cloud Run connection keepalive
 * - Graceful SIGTERM/SIGINT shutdown
 */

import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'crypto';

// Google Cloud Run dynamically injects process.env.PORT (usually 8080)
const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = '0.0.0.0';

// In-memory ephemeral state (no database, no permanent storage)
const rooms = new Map(); // roomNumber -> { roomNumber, ownerId, members: Map<peerId, Member>, createdAt }
const socketMetadata = new WeakMap(); // ws -> { peerId, roomNumber }

// Create HTTP Server for Cloud Run health checks and WebSocket upgrade handling
const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Upgrade, Connection');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check endpoints for Google Cloud Run container liveness probe
  if (req.url === '/health' || req.url === '/' || req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      service: 'GO-CHAT Signalling Server',
      environment: process.env.NODE_ENV || 'production',
      status: 'healthy',
      totalActiveRooms: rooms.size,
      timestamp: new Date().toISOString()
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

// Attach WebSocket Server
const wss = new WebSocketServer({ server });

function send(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function handleLeaveRoom(ws) {
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

  room.members.delete(meta.peerId);
  meta.roomNumber = undefined;

  // When last user leaves, destroy the room and its temporary state
  if (room.members.size === 0) {
    rooms.delete(room.roomNumber);
    console.log(`[GO-CHAT] Room #${room.roomNumber} destroyed (empty).`);
    return;
  }

  // If the owner left, reassign ownership to the next remaining member
  let newOwnerId = room.ownerId;
  if (wasOwner) {
    const nextOwner = room.members.values().next().value;
    if (nextOwner) {
      nextOwner.isOwner = true;
      room.ownerId = nextOwner.id;
      newOwnerId = nextOwner.id;
      console.log(`[GO-CHAT] Room #${room.roomNumber} new Owner: ${nextOwner.name} (${nextOwner.id})`);
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

wss.on('connection', (ws) => {
  const peerId = crypto.randomUUID();
  socketMetadata.set(ws, { peerId });
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  // Acknowledge connection immediately
  send(ws, {
    type: 'connected',
    peerId: peerId
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const meta = socketMetadata.get(ws);
      if (!meta) return;

      switch (msg.type) {
        case 'ping': {
          ws.isAlive = true;
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
              members: new Map(),
              createdAt: Date.now()
            };
            rooms.set(roomNumber, room);
            console.log(`[GO-CHAT] Room #${roomNumber} created by ${name} (Owner).`);
          }

          const isOwner = isFirstUser || room.ownerId === peerId;
          const member = {
            id: peerId,
            name,
            isOwner,
            ws,
            isAlive: true
          };

          room.members.set(peerId, member);

          // 1. Send confirmation + current member list to joining user
          send(ws, {
            type: 'room-joined',
            peerId,
            room: roomNumber,
            isOwner,
            members: Array.from(room.members.values()).map(m => ({
              id: m.id,
              name: m.name,
              isOwner: m.isOwner
            }))
          });

          // 2. Broadcast user-joined to all other members in this room
          for (const other of room.members.values()) {
            if (other.id !== peerId) {
              send(other.ws, {
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
          // WebRTC signalling: offer, answer, ice-candidate
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
          // Fallback room delivery
          if (!meta.roomNumber) return;
          const room = rooms.get(meta.roomNumber);
          if (!room) return;

          const sender = room.members.get(peerId);
          const senderName = sender ? sender.name : 'Anonymous';
          const text = String(msg.text || '').trim();
          if (!text) return;

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
    console.error(`[GO-CHAT] WebSocket error for peer ${peerId}:`, err);
    handleLeaveRoom(ws);
  });
});

// Periodic heartbeat / ping interval to keep Cloud Run connections alive & prune dead sockets
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      handleLeaveRoom(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 20000);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

// Graceful shutdown handling for Google Cloud Run container termination
function gracefulShutdown(signal) {
  console.log(`[GO-CHAT] Received ${signal}. Closing server gracefully...`);
  clearInterval(heartbeatInterval);
  wss.close(() => {
    server.close(() => {
      console.log('[GO-CHAT] Server closed. Exiting process.');
      process.exit(0);
    });
  });
  // Force shutdown if taking longer than 5 seconds
  setTimeout(() => {
    console.error('[GO-CHAT] Forceful exit timeout.');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

server.listen(PORT, HOST, () => {
  console.log(`===================================================`);
  console.log(` GO-CHAT Signalling Server running on port ${PORT}`);
  console.log(` Compatible with Google Cloud Run, Render, & local`);
  console.log(` Host: ${HOST} | Port: ${PORT}`);
  console.log(`===================================================`);
});
