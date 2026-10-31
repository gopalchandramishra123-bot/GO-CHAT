/**
 * GO-CHAT - Frontend Configuration
 * Production & Development Signalling Settings
 */

// ============================================================================
// PRODUCTION BACKEND URL CONFIGURATION
// ============================================================================
// When deploying the frontend to Netlify, paste your Google Cloud Run WebSocket URL here:
// Example: 'wss://go-chat-backend-xyz-uc.a.run.app'
export const PRODUCTION_BACKEND_WSS_URL = '';

/**
 * Normalizes input URL to valid WebSocket protocol (ws:// or wss://)
 */
export function sanitizeWsUrl(url) {
  if (!url) return '';
  let cleaned = url.trim();
  if (cleaned.startsWith('https://')) {
    cleaned = 'wss://' + cleaned.slice(8);
  } else if (cleaned.startsWith('http://')) {
    cleaned = 'ws://' + cleaned.slice(7);
  } else if (!cleaned.startsWith('ws://') && !cleaned.startsWith('wss://')) {
    // Default to wss:// for secure cloud endpoints
    cleaned = 'wss://' + cleaned;
  }
  return cleaned;
}

export const CONFIG = {
  // WebRTC ICE / Google STUN Servers (public, free, zero registration required)
  RTC_CONFIGURATION: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' }
    ]
  },

  // Heartbeat ping interval to keep Cloud Run WebSocket connections active
  HEARTBEAT_INTERVAL_MS: 15000,
  RECONNECT_RETRY_MS: 3000,

  /**
   * Resolves the Signalling Server WebSocket URL based on runtime environment:
   * 1. Query parameter override: ?server=wss://... or ?ws=wss://...
   * 2. In-memory / session override from UI modal
   * 3. PRODUCTION_BACKEND_WSS_URL constant (if populated)
   * 4. Current host (when running in full-stack dev/container)
   * 5. Netlify guard (prompts user to enter backend URL since Netlify does not support WebSockets)
   */
  getSignalingUrl: () => {
    if (typeof window === 'undefined') return 'ws://localhost:3000';

    // 1. Check URL query parameters: ?server=wss://...
    const urlParams = new URLSearchParams(window.location.search);
    const queryServer = urlParams.get('server') || urlParams.get('ws');
    if (queryServer) {
      return sanitizeWsUrl(queryServer);
    }

    // 2. Check in-memory UI setting
    if (window.__GO_CHAT_SERVER_URL__) {
      return sanitizeWsUrl(window.__GO_CHAT_SERVER_URL__);
    }

    // 3. Check hardcoded production backend URL
    if (PRODUCTION_BACKEND_WSS_URL && PRODUCTION_BACKEND_WSS_URL.trim()) {
      return sanitizeWsUrl(PRODUCTION_BACKEND_WSS_URL.trim());
    }

    // 4. If running on Netlify and no backend configured yet, return empty to prompt setup
    const isNetlify = window.location.hostname.includes('netlify.app');
    if (isNetlify) {
      return '';
    }

    // 5. Default to same origin for local dev / Cloud Run full-stack container
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}`;
  }
};
