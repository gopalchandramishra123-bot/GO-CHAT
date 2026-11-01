/**
 * GO-CHAT - Phase 2 Production Frontend Script
 * Real-Time Room Management with WebRTC P2P Data Channels & WebSocket Signalling
 * Compatible with Netlify frontend + Google Cloud Run backend
 * Vanilla JavaScript (No React or other frameworks)
 */

import { CONFIG, sanitizeWsUrl } from './config.js';

(() => {
  'use strict';

  // --- Application State ---
  const state = {
    currentUser: null,       // { name: string, initial: string }
    currentRoom: null,       // string
    myPeerId: null,          // string (assigned by signalling server)
    isOwner: false,          // boolean (first user in room becomes owner)
    members: [],             // Array of { id, name, isOwner }
    peers: new Map(),        // Map<peerId, { pc: RTCPeerConnection, dc: RTCDataChannel, name: string }>
    receivedMessageIds: new Set(), // Deduplication check for reliable delivery
    activeTheme: 'dark',
    signalingUrl: CONFIG.getSignalingUrl(),
    socket: null,
    socketStatus: 'connecting', // 'connecting' | 'connected' | 'disconnected'
    reconnectTimer: null,
    pingInterval: null,
    isSidebarOpen: false
  };

  // --- DOM Elements ---
  const elements = {
    // Views
    welcomeScreen: document.getElementById('welcome-screen'),
    chatScreen: document.getElementById('chat-screen'),

    // Server Status Indicators
    welcomeStatusBtn: document.getElementById('welcome-server-status-btn'),
    welcomeStatusText: document.getElementById('welcome-server-status-text'),
    headerStatusBtn: document.getElementById('header-server-status-btn'),
    headerStatusText: document.getElementById('header-server-status-text'),
    roomSessionStatus: document.getElementById('room-session-status'),
    p2pBadge: document.getElementById('p2p-badge'),

    // Server Config Modal
    serverConfigModal: document.getElementById('server-config-modal'),
    serverUrlInput: document.getElementById('server-url-input'),
    modalServerStatus: document.getElementById('modal-server-status'),
    modalCloseBtn: document.getElementById('modal-close-btn'),
    modalSaveBtn: document.getElementById('modal-save-btn'),
    modalResetBtn: document.getElementById('modal-reset-btn'),

    // Welcome Form
    joinForm: document.getElementById('join-form'),
    userNameInput: document.getElementById('user-name-input'),
    roomNumberInput: document.getElementById('room-number-input'),
    formError: document.getElementById('form-error'),
    errorMessage: document.getElementById('error-message'),
    joinBtn: document.getElementById('join-btn'),
    quickRoomChips: document.querySelectorAll('.room-chip'),
    welcomeSwatches: document.querySelectorAll('.theme-swatch'),

    // Chat Header
    activeRoomDisplay: document.getElementById('active-room-display'),
    copyRoomBtn: document.getElementById('copy-room-btn'),
    headerThemeDropdown: document.getElementById('header-theme-dropdown'),
    leaveRoomBtn: document.getElementById('leave-room-btn'),
    toggleMembersBtn: document.getElementById('toggle-members-btn'),

    // Sidebar
    membersSidebar: document.getElementById('members-sidebar'),
    sidebarCloseBtn: document.getElementById('sidebar-close-btn'),
    sidebarOverlay: document.getElementById('sidebar-overlay'),
    membersList: document.getElementById('members-list'),
    memberCountBadge: document.getElementById('member-count-badge'),
    sidebarRoomNumber: document.getElementById('sidebar-room-number'),
    sidebarCopyBtn: document.getElementById('sidebar-copy-btn'),

    // Chat Area
    chatMessagesContainer: document.getElementById('messages-container'),
    roomWelcomeTitle: document.getElementById('room-welcome-title'),
    roomWelcomeText: document.getElementById('room-welcome-text'),
    clearChatBtn: document.getElementById('clear-chat-btn'),

    // Chat Input Form
    messageForm: document.getElementById('message-form'),
    messageInput: document.getElementById('message-input'),
    sendBtn: document.getElementById('send-btn'),
    reactionChips: document.querySelectorAll('.reaction-chip'),

    // Toast Notice
    toastNotice: document.getElementById('toast-notice'),

    // About Developer Modal Elements
    openAboutDevBtn: document.getElementById('open-about-dev-btn'),
    sidebarDevCard: document.getElementById('sidebar-dev-card'),
    aboutDevModal: document.getElementById('about-dev-modal'),
    devModalCloseBtn: document.getElementById('dev-modal-close-btn'),
    devModalOkBtn: document.getElementById('dev-modal-ok-btn')
  };

  // --- Timestamp Formatter ---
  function formatTimestamp(date = new Date()) {
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const formattedHours = hours % 12 || 12;
    const formattedMinutes = minutes < 10 ? `0${minutes}` : minutes;
    return `${formattedHours}:${formattedMinutes} ${ampm}`;
  }

  // --- Toast Notification ---
  let toastTimeout = null;
  function showToast(message) {
    if (!elements.toastNotice) return;
    elements.toastNotice.textContent = message;
    elements.toastNotice.classList.add('show');

    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      elements.toastNotice.classList.remove('show');
    }, 2400);
  }

  // --- Clipboard Helper ---
  async function copyToClipboard(text, successMsg = 'Copied to clipboard!') {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.opacity = '0';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      }
      showToast(successMsg);
    } catch {
      showToast(`Copy: ${text}`);
    }
  }

  // --- Theme Management ---
  function setTheme(themeName) {
    const validThemes = ['dark', 'light-blue', 'light-pink', 'light-purple', 'light-green'];
    if (!validThemes.includes(themeName)) return;

    state.activeTheme = themeName;
    document.documentElement.setAttribute('data-theme', themeName);

    if (elements.headerThemeDropdown) {
      elements.headerThemeDropdown.value = themeName;
    }

    elements.welcomeSwatches.forEach(swatch => {
      if (swatch.dataset.theme === themeName) {
        swatch.classList.add('active');
      } else {
        swatch.classList.remove('active');
      }
    });
  }

  // --- Server Status Indicators ---
  function updateServerStatus(status, text) {
    state.socketStatus = status;

    const setStatusClass = (btn, txtEl) => {
      if (!btn) return;
      btn.classList.remove('connecting', 'connected', 'disconnected');
      btn.classList.add(status);
      if (txtEl) txtEl.textContent = text;
    };

    setStatusClass(elements.welcomeStatusBtn, elements.welcomeStatusText);
    setStatusClass(elements.headerStatusBtn, elements.headerStatusText);

    if (elements.modalServerStatus) {
      const urlDisplay = state.signalingUrl || 'Not Configured';
      elements.modalServerStatus.textContent = `Status: ${text.toUpperCase()} (${urlDisplay})`;
    }
  }

  // --- WebSocket Signalling Setup ---
  function connectSignalingServer() {
    if (state.socket) {
      try {
        state.socket.close();
      } catch {}
      state.socket = null;
    }

    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }

    if (state.pingInterval) {
      clearInterval(state.pingInterval);
      state.pingInterval = null;
    }

    // Check if a signalling URL is available
    if (!state.signalingUrl || !state.signalingUrl.trim()) {
      updateServerStatus('disconnected', 'Signalling: Configure Server URL');
      return;
    }

    updateServerStatus('connecting', 'Signalling: Connecting...');

    try {
      state.socket = new WebSocket(state.signalingUrl);
    } catch (err) {
      console.error('[Signalling] WebSocket error:', err);
      updateServerStatus('disconnected', 'Signalling: Disconnected');
      scheduleReconnect();
      return;
    }

    state.socket.onopen = () => {
      console.log('[Signalling] Connected to:', state.signalingUrl);
      updateServerStatus('connected', 'Signalling: Connected');

      // Heartbeat ping to prevent Cloud Run idle timeout
      state.pingInterval = setInterval(() => {
        if (state.socket && state.socket.readyState === WebSocket.OPEN) {
          state.socket.send(JSON.stringify({ type: 'ping' }));
        }
      }, CONFIG.HEARTBEAT_INTERVAL_MS);

      // Re-join active room if connection recovered
      if (state.currentRoom && state.currentUser) {
        state.socket.send(JSON.stringify({
          type: 'join-room',
          room: state.currentRoom,
          name: state.currentUser.name
        }));
      }
    };

    state.socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleSignalingMessage(msg);
      } catch (err) {
        console.error('[Signalling] Message parse error:', err);
      }
    };

    state.socket.onclose = () => {
      console.warn('[Signalling] Connection closed');
      updateServerStatus('disconnected', 'Signalling: Disconnected');
      scheduleReconnect();
    };

    state.socket.onerror = (err) => {
      console.error('[Signalling] WebSocket error:', err);
      updateServerStatus('disconnected', 'Signalling: Disconnected');
    };
  }

  function scheduleReconnect() {
    if (!state.signalingUrl) return;

    if (!state.reconnectTimer) {
      state.reconnectTimer = setTimeout(() => {
        state.reconnectTimer = null;
        console.log('[Signalling] Attempting to reconnect...');
        connectSignalingServer();
      }, CONFIG.RECONNECT_RETRY_MS);
    }
  }

  function sendSignaling(payload) {
    if (state.socket && state.socket.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify(payload));
    }
  }

  // --- Signalling Message Handler ---
  function handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'connected':
        state.myPeerId = msg.peerId;
        break;

      case 'pong':
        break;

      case 'room-joined': {
        state.myPeerId = msg.peerId;
        state.isOwner = !!msg.isOwner;
        state.members = msg.members || [];

        updateRoomUI();
        renderOnlineMembers();

        // Connect to existing room members via WebRTC
        state.members.forEach(member => {
          if (member.id !== state.myPeerId) {
            initiatePeerConnection(member.id, member.name);
          }
        });
        break;
      }

      case 'user-joined': {
        const newUser = msg.user;
        // Avoid duplicate member addition (idempotent)
        if (!state.members.some(m => m.id === newUser.id)) {
          state.members.push(newUser);
        }
        renderOnlineMembers();
        renderSystemMessage(`${newUser.name} joined the room`, 'join-event');
        break;
      }

      case 'user-left': {
        const { id, name, newOwnerId } = msg;
        state.members = state.members.filter(m => m.id !== id);

        // Close peer connection
        closePeer(id);

        // Check if ownership transferred to me
        if (newOwnerId && newOwnerId === state.myPeerId && !state.isOwner) {
          state.isOwner = true;
          renderSystemMessage('You are now the room OWNER', 'owner-event');
        }

        // Update members list
        state.members.forEach(m => {
          m.isOwner = (m.id === newOwnerId);
        });

        renderOnlineMembers();
        renderSystemMessage(`${name || 'A user'} left the room`, 'leave-event');
        break;
      }

      case 'signal': {
        handlePeerSignal(msg.senderId, msg.signal);
        break;
      }

      case 'chat-message': {
        handleIncomingMessage({
          id: msg.id,
          sender: msg.senderName,
          text: msg.text,
          timestamp: msg.timestamp
        });
        break;
      }

      case 'error':
        displayError(msg.message);
        break;
    }
  }

  // --- WebRTC Peer-to-Peer Mesh Connection ---

  function createPeerConnection(peerId, peerName = 'Peer') {
    if (state.peers.has(peerId)) {
      return state.peers.get(peerId).pc;
    }

    const pc = new RTCPeerConnection(CONFIG.RTC_CONFIGURATION);
    const peerData = { pc, dc: null, name: peerName };
    state.peers.set(peerId, peerData);

    // Relaying ICE Candidates through Signalling Server
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignaling({
          type: 'signal',
          targetId: peerId,
          signal: {
            type: 'candidate',
            candidate: event.candidate
          }
        });
      }
    };

    // Incoming Data Channel from remote initiator
    pc.ondatachannel = (event) => {
      const channel = event.channel;
      setupDataChannel(peerId, channel);
    };

    pc.onconnectionstatechange = () => {
      checkP2PStatus();
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        closePeer(peerId);
      }
    };

    return pc;
  }

  function setupDataChannel(peerId, dc) {
    const peerData = state.peers.get(peerId);
    if (!peerData) return;
    peerData.dc = dc;

    dc.onopen = () => {
      console.log(`[WebRTC] P2P DataChannel OPEN with peer ${peerId}`);
      checkP2PStatus();
    };

    dc.onclose = () => {
      console.log(`[WebRTC] P2P DataChannel CLOSED with peer ${peerId}`);
      checkP2PStatus();
    };

    dc.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleIncomingMessage(msg);
      } catch (err) {
        console.error('[WebRTC] DataChannel message parse error:', err);
      }
    };
  }

  async function initiatePeerConnection(peerId, peerName) {
    try {
      const pc = createPeerConnection(peerId, peerName);

      // Create P2P Data Channel
      const dc = pc.createDataChannel('go-chat-data');
      setupDataChannel(peerId, dc);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      sendSignaling({
        type: 'signal',
        targetId: peerId,
        signal: {
          type: 'offer',
          sdp: offer.sdp
        }
      });
    } catch (err) {
      console.error(`[WebRTC] Connection initiation failed for ${peerId}:`, err);
    }
  }

  async function handlePeerSignal(senderId, signal) {
    try {
      let peerData = state.peers.get(senderId);
      let pc = peerData ? peerData.pc : createPeerConnection(senderId);

      if (signal.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: signal.sdp }));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        sendSignaling({
          type: 'signal',
          targetId: senderId,
          signal: {
            type: 'answer',
            sdp: answer.sdp
          }
        });
      } else if (signal.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: signal.sdp }));
      } else if (signal.type === 'candidate') {
        if (signal.candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        }
      }
    } catch (err) {
      console.error('[WebRTC] Signal handling error:', err);
    }
  }

  function closePeer(peerId) {
    const peerData = state.peers.get(peerId);
    if (peerData) {
      if (peerData.dc) {
        try { peerData.dc.close(); } catch {}
      }
      if (peerData.pc) {
        try { peerData.pc.close(); } catch {}
      }
      state.peers.delete(peerId);
    }
    checkP2PStatus();
  }

  function closeAllPeers() {
    for (const [peerId] of state.peers) {
      closePeer(peerId);
    }
    state.peers.clear();
    checkP2PStatus();
  }

  function checkP2PStatus() {
    let openChannels = 0;
    for (const [, peer] of state.peers) {
      if (peer.dc && peer.dc.readyState === 'open') {
        openChannels++;
      }
    }

    if (!elements.p2pBadge) return;
    if (openChannels > 0) {
      elements.p2pBadge.textContent = `WebRTC P2P (${openChannels} active)`;
      elements.p2pBadge.style.background = 'rgba(16, 185, 129, 0.2)';
      elements.p2pBadge.style.color = '#10b981';
    } else if (state.members.length > 1) {
      elements.p2pBadge.textContent = 'Signalling Relay';
      elements.p2pBadge.style.background = 'rgba(245, 158, 11, 0.2)';
      elements.p2pBadge.style.color = '#f59e0b';
    } else {
      elements.p2pBadge.textContent = 'Room Ready (Solo)';
      elements.p2pBadge.style.background = 'var(--accent-light)';
      elements.p2pBadge.style.color = 'var(--accent-primary)';
    }
  }

  // --- Room Join & Leave Logic ---

  function validateJoinInputs(name, room) {
    const trimmedName = name.trim();
    const trimmedRoom = room.trim();

    if (!trimmedName) {
      return { valid: false, error: 'Please enter your name.' };
    }
    if (trimmedName.length < 2) {
      return { valid: false, error: 'Name must be at least 2 characters.' };
    }
    if (trimmedName.length > 25) {
      return { valid: false, error: 'Name must not exceed 25 characters.' };
    }

    if (!trimmedRoom) {
      return { valid: false, error: 'Please enter a Room Number.' };
    }
    const roomRegex = /^[a-zA-Z0-9_-]{1,16}$/;
    if (!roomRegex.test(trimmedRoom)) {
      return { valid: false, error: 'Room number must be 1-16 letters, numbers, or dashes.' };
    }

    return { valid: true, error: null };
  }

  function displayError(msg) {
    if (!elements.formError) return;
    if (msg) {
      elements.errorMessage.textContent = msg;
      elements.formError.classList.remove('hidden');
    } else {
      elements.formError.classList.add('hidden');
    }
  }

  function joinRoom(name, room) {
    // If no backend configured or disconnected, open modal to configure backend URL
    if (!state.signalingUrl || !state.signalingUrl.trim()) {
      displayError('Signalling server URL is not configured. Please enter your Google Cloud Run WSS URL.');
      openServerModal();
      return;
    }

    if (state.socketStatus !== 'connected') {
      displayError('Signalling server is not connected. Click below to verify or configure Server URL.');
      openServerModal();
      return;
    }

    const validation = validateJoinInputs(name, room);
    if (!validation.valid) {
      displayError(validation.error);
      return;
    }

    displayError(null);

    state.currentUser = {
      name: name.trim(),
      initial: name.trim().charAt(0).toUpperCase()
    };
    state.currentRoom = room.trim();

    // Send Join request to Server
    sendSignaling({
      type: 'join-room',
      room: state.currentRoom,
      name: state.currentUser.name
    });

    // Switch view to Chat Screen
    elements.welcomeScreen.classList.add('hidden');
    elements.chatScreen.classList.remove('hidden');

    elements.chatMessagesContainer.innerHTML = '';
    state.receivedMessageIds.clear();

    renderSystemMessage(`You entered Room #${state.currentRoom}`);

    setTimeout(() => {
      elements.messageInput.focus();
    }, 100);
  }

  function updateRoomUI() {
    if (elements.activeRoomDisplay) {
      elements.activeRoomDisplay.textContent = `#${state.currentRoom}`;
    }
    if (elements.sidebarRoomNumber) {
      elements.sidebarRoomNumber.textContent = `#${state.currentRoom}`;
    }
    if (elements.roomWelcomeTitle) {
      elements.roomWelcomeTitle.textContent = `Welcome to Room #${state.currentRoom}`;
    }
    if (elements.roomWelcomeText) {
      elements.roomWelcomeText.textContent = state.isOwner
        ? `You are the Room OWNER. Share Room #${state.currentRoom} to invite peers.`
        : `Connected to Room #${state.currentRoom}.`;
    }
  }

  function leaveRoom() {
    if (state.currentRoom) {
      sendSignaling({ type: 'leave-room' });
    }

    closeAllPeers();

    state.currentUser = null;
    state.currentRoom = null;
    state.isOwner = false;
    state.members = [];
    state.receivedMessageIds.clear();

    closeMobileSidebar();

    elements.chatScreen.classList.add('hidden');
    elements.welcomeScreen.classList.remove('hidden');

    elements.messageInput.value = '';
    displayError(null);
  }

  // --- Real Online Members List Rendering ---
  function renderOnlineMembers() {
    if (!elements.membersList) return;
    elements.membersList.innerHTML = '';

    const count = state.members.length;
    if (elements.memberCountBadge) {
      elements.memberCountBadge.textContent = String(count);
    }

    if (count === 0 && state.currentUser) {
      const selfCard = createMemberCardElement({
        name: state.currentUser.name,
        isOwner: state.isOwner,
        isSelf: true
      });
      elements.membersList.appendChild(selfCard);
      return;
    }

    state.members.forEach(member => {
      const isSelf = member.id === state.myPeerId;
      const card = createMemberCardElement({
        name: member.name,
        isOwner: !!member.isOwner,
        isSelf
      });
      elements.membersList.appendChild(card);
    });

    if (count <= 1) {
      const notice = document.createElement('div');
      notice.style.cssText = 'padding: 0.85rem; border-radius: 10px; background: var(--bg-tertiary); font-size: 0.75rem; color: var(--text-muted); margin-top: 0.5rem; border: 1px dashed var(--border-subtle); text-align: center;';
      notice.innerHTML = `
        <div style="font-weight: 600; color: var(--text-secondary); margin-bottom: 0.2rem;">Waiting for peers</div>
        Open this room in Chrome, Firefox or mobile with Room <strong>#${escapeHtml(state.currentRoom)}</strong>!
      `;
      elements.membersList.appendChild(notice);
    }

    checkP2PStatus();
  }

  function createMemberCardElement({ name, isOwner, isSelf }) {
    const card = document.createElement('div');
    card.className = 'member-card';

    const initial = name ? name.charAt(0).toUpperCase() : '?';

    card.innerHTML = `
      <div class="member-avatar">
        ${escapeHtml(initial)}
        <span class="member-status-indicator" title="Online"></span>
      </div>
      <div class="member-info">
        <div class="member-name-row">
          <span class="member-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
          ${isSelf ? '<span class="you-pill">You</span>' : ''}
          ${isOwner ? '<span class="owner-pill">★ Owner</span>' : ''}
        </div>
        <span class="member-role">${isOwner ? 'Room Owner' : 'Member'} · Active</span>
      </div>
    `;
    return card;
  }

  // --- System Broadcast Renderer ---
  function renderSystemMessage(text, extraClass = '') {
    const sysEl = document.createElement('div');
    sysEl.className = `system-message ${extraClass}`;
    sysEl.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="16" x2="12" y2="12"></line>
        <line x1="12" y1="8" x2="12.01" y2="8"></line>
      </svg>
      <span>${escapeHtml(text)}</span>
    `;
    elements.chatMessagesContainer.appendChild(sysEl);
    scrollToBottom();
  }

  // --- Real Message Delivery (WebRTC P2P + Server Relay) ---

  function sendMessage(text) {
    const trimmed = text.trim();
    if (!trimmed) return;

    const messageObj = {
      id: 'msg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6),
      sender: state.currentUser ? state.currentUser.name : 'You',
      text: trimmed,
      timestamp: formatTimestamp()
    };

    // Mark as seen locally to prevent duplicate on relay loopback
    state.receivedMessageIds.add(messageObj.id);

    // 1. Deliver directly via WebRTC Data Channels
    const serialized = JSON.stringify(messageObj);
    for (const [, peer] of state.peers) {
      if (peer.dc && peer.dc.readyState === 'open') {
        try {
          peer.dc.send(serialized);
        } catch (e) {
          console.warn('[WebRTC] Send failed, relying on server relay:', e);
        }
      }
    }

    // 2. Transmit via WebSocket server relay for peers still negotiating WebRTC
    sendSignaling({
      type: 'chat-message',
      id: messageObj.id,
      text: messageObj.text,
      timestamp: messageObj.timestamp
    });

    // 3. Render locally as outgoing message on the right
    renderMessageBubble(messageObj, 'outgoing');
  }

  function handleIncomingMessage(msg) {
    if (!msg || !msg.id) return;

    // Deduplicate messages received via both WebRTC and Server Relay
    if (state.receivedMessageIds.has(msg.id)) {
      return;
    }
    state.receivedMessageIds.add(msg.id);

    // Render incoming message on the left
    renderMessageBubble(msg, 'incoming');
  }

  function renderMessageBubble(msg, type) {
    const row = document.createElement('div');
    row.className = `message-row ${type}`;
    row.id = msg.id;

    const initial = msg.sender ? msg.sender.charAt(0).toUpperCase() : '?';

    row.innerHTML = `
      <div class="msg-avatar" title="${escapeHtml(msg.sender)}">
        ${escapeHtml(initial)}
      </div>
      <div class="msg-content-wrapper">
        <div class="msg-header-info">
          <span class="msg-sender-name">${escapeHtml(msg.sender)}</span>
          <span class="msg-timestamp tabular-nums">${escapeHtml(msg.timestamp)}</span>
        </div>
        <div class="msg-bubble-container">
          <div class="msg-bubble">
            ${escapeHtml(msg.text)}
          </div>
          <div class="msg-actions">
            <button class="msg-action-btn copy-btn" title="Copy message" data-id="${msg.id}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            </button>
            <button class="msg-action-btn delete-btn" title="Delete message" data-id="${msg.id}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              </svg>
            </button>
          </div>
        </div>
      </div>
    `;

    const copyBtn = row.querySelector('.copy-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        copyToClipboard(msg.text, 'Message copied!');
      });
    }

    const deleteBtn = row.querySelector('.delete-btn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteLocalMessage(msg.id);
      });
    }

    elements.chatMessagesContainer.appendChild(row);
    scrollToBottom();
  }

  function deleteLocalMessage(id) {
    const el = document.getElementById(id);
    if (el) {
      el.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
      el.style.opacity = '0';
      el.style.transform = 'scale(0.95)';
      setTimeout(() => {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 200);
    }
    showToast('Message removed from screen');
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      elements.chatMessagesContainer.scrollTop = elements.chatMessagesContainer.scrollHeight;
    });
  }

  // --- Mobile Sidebar Controls ---
  function openMobileSidebar() {
    state.isSidebarOpen = true;
    elements.membersSidebar.classList.add('open');
    elements.sidebarOverlay.classList.add('active');
  }

  function closeMobileSidebar() {
    state.isSidebarOpen = false;
    elements.membersSidebar.classList.remove('open');
    elements.sidebarOverlay.classList.remove('active');
  }

  // --- Server Settings Modal ---
  function openServerModal() {
    elements.serverUrlInput.value = state.signalingUrl || '';
    elements.serverConfigModal.classList.remove('hidden');
    if (elements.modalServerStatus) {
      const text = state.socketStatus.toUpperCase();
      const url = state.signalingUrl || 'Not Configured';
      elements.modalServerStatus.textContent = `Status: ${text} (${url})`;
    }
  }

  function closeServerModal() {
    elements.serverConfigModal.classList.add('hidden');
  }

  function saveServerConfig() {
    const rawUrl = elements.serverUrlInput.value.trim();
    if (!rawUrl) {
      alert('Please enter your WebSocket server URL (e.g. wss://your-backend.a.run.app)');
      return;
    }

    const sanitized = sanitizeWsUrl(rawUrl);
    state.signalingUrl = sanitized;
    window.__GO_CHAT_SERVER_URL__ = sanitized;

    closeServerModal();
    showToast(`Connecting to ${sanitized}...`);
    connectSignalingServer();
  }

  function resetServerConfig() {
    window.__GO_CHAT_SERVER_URL__ = undefined;
    state.signalingUrl = CONFIG.getSignalingUrl();
    elements.serverUrlInput.value = state.signalingUrl;
    showToast('Reset to default URL');
    connectSignalingServer();
  }

  // --- About Developer Modal Functions ---
  function openAboutDevModal() {
    if (elements.aboutDevModal) {
      elements.aboutDevModal.classList.remove('hidden');
    }
  }

  function closeAboutDevModal() {
    if (elements.aboutDevModal) {
      elements.aboutDevModal.classList.add('hidden');
    }
  }

  // --- Safe HTML Escape ---
  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // --- Event Listeners Setup ---
  function initEventListeners() {
    // Join Form Submit
    if (elements.joinForm) {
      elements.joinForm.addEventListener('submit', (e) => {
        e.preventDefault();
        joinRoom(elements.userNameInput.value, elements.roomNumberInput.value);
      });
    }

    // Quick room chips
    elements.quickRoomChips.forEach(chip => {
      chip.addEventListener('click', () => {
        const roomVal = chip.dataset.room;
        if (roomVal && elements.roomNumberInput) {
          elements.roomNumberInput.value = roomVal;
          elements.userNameInput.focus();
        }
      });
    });

    // Theme swatches on Welcome Screen
    elements.welcomeSwatches.forEach(swatch => {
      swatch.addEventListener('click', () => {
        setTheme(swatch.dataset.theme);
      });
    });

    // Theme dropdown in Chat Header
    if (elements.headerThemeDropdown) {
      elements.headerThemeDropdown.addEventListener('change', (e) => {
        setTheme(e.target.value);
      });
    }

    // Leave Room Button
    if (elements.leaveRoomBtn) {
      elements.leaveRoomBtn.addEventListener('click', leaveRoom);
    }

    // Message Form Submit
    if (elements.messageForm) {
      elements.messageForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = elements.messageInput.value;
        if (text && text.trim()) {
          sendMessage(text);
          elements.messageInput.value = '';
          elements.messageInput.focus();
        }
      });
    }

    // Enter key submits message
    if (elements.messageInput) {
      elements.messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          elements.messageForm.dispatchEvent(new Event('submit'));
        }
      });
    }

    // Quick Reaction Chips
    elements.reactionChips.forEach(chip => {
      chip.addEventListener('click', () => {
        const reaction = chip.textContent;
        if (elements.messageInput) {
          elements.messageInput.value += (elements.messageInput.value ? ' ' : '') + reaction;
          elements.messageInput.focus();
        }
      });
    });

    // Copy Room ID
    if (elements.copyRoomBtn) {
      elements.copyRoomBtn.addEventListener('click', () => {
        if (state.currentRoom) {
          copyToClipboard(state.currentRoom, `Room #${state.currentRoom} copied!`);
        }
      });
    }

    if (elements.sidebarCopyBtn) {
      elements.sidebarCopyBtn.addEventListener('click', () => {
        if (state.currentRoom) {
          copyToClipboard(state.currentRoom, `Room #${state.currentRoom} code copied!`);
        }
      });
    }

    // Clear Screen Button
    if (elements.clearChatBtn) {
      elements.clearChatBtn.addEventListener('click', () => {
        elements.chatMessagesContainer.innerHTML = '';
        renderSystemMessage('Local screen cleared');
      });
    }

    // Mobile Sidebar Drawer
    if (elements.toggleMembersBtn) {
      elements.toggleMembersBtn.addEventListener('click', () => {
        if (state.isSidebarOpen) {
          closeMobileSidebar();
        } else {
          openMobileSidebar();
        }
      });
    }

    if (elements.sidebarCloseBtn) {
      elements.sidebarCloseBtn.addEventListener('click', closeMobileSidebar);
    }

    if (elements.sidebarOverlay) {
      elements.sidebarOverlay.addEventListener('click', closeMobileSidebar);
    }

    // Server Config Modal Events
    
    /* 
    ........................................................................
    if (elements.welcomeStatusBtn) {
      elements.welcomeStatusBtn.addEventListener('click', openServerModal);
    }

    if (elements.headerStatusBtn) {
      elements.headerStatusBtn.addEventListener('click', openServerModal);
    } 
    
    //THAT USE GOPAL ONLY WHEN YOU WANT SERVER Link  Through Run or TEST 
    ......................................................................
    */
    if (elements.modalCloseBtn) {
      elements.modalCloseBtn.addEventListener('click', closeServerModal);
    }

    if (elements.modalSaveBtn) {
      elements.modalSaveBtn.addEventListener('click', saveServerConfig);
    }

    if (elements.modalResetBtn) {
      elements.modalResetBtn.addEventListener('click', resetServerConfig);
    }

    // About Developer Modal Events
    if (elements.openAboutDevBtn) {
      elements.openAboutDevBtn.addEventListener('click', openAboutDevModal);
    }

    if (elements.sidebarDevCard) {
      elements.sidebarDevCard.addEventListener('click', openAboutDevModal);
    }

    if (elements.devModalCloseBtn) {
      elements.devModalCloseBtn.addEventListener('click', closeAboutDevModal);
    }

    if (elements.devModalOkBtn) {
      elements.devModalOkBtn.addEventListener('click', closeAboutDevModal);
    }

    // Window Unload: Notify server
    window.addEventListener('beforeunload', () => {
      if (state.currentRoom && state.socket && state.socket.readyState === WebSocket.OPEN) {
        state.socket.send(JSON.stringify({ type: 'leave-room' }));
      }
      closeAllPeers();
    });
  }

  // --- Bootstrap ---
  function init() {
    setTheme('dark');
    initEventListeners();
    connectSignalingServer();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
