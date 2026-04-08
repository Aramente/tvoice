// WebSocket handler: routes terminal I/O between the client and the session
// manager. Protocol:
//
//   client -> server
//     { type: 'attach',  sessionId, cols, rows }
//     { type: 'create',  cols, rows, title? }
//     { type: 'input',   data }
//     { type: 'resize',  cols, rows }
//     { type: 'detach' }
//     { type: 'close' }
//     { type: 'ping' }
//
//   server -> client
//     { type: 'attached',  session, snapshot }
//     { type: 'created',   session }
//     { type: 'data',      data }
//     { type: 'title',     aiMode }
//     { type: 'exit',      exitCode, signal }
//     { type: 'error',     message }
//     { type: 'pong' }

import { WebSocketServer } from 'ws';
import { verifyAccessToken, getAccessTokenFromRequest } from './auth.js';

export function attachWebSocket({ httpServer, cfg, sessions }) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', async (req, socket, head) => {
    if (!req.url?.startsWith('/ws')) {
      socket.destroy();
      return;
    }
    const token = getAccessTokenFromRequest(req);
    const claims = await verifyAccessToken(cfg, token);
    if (!claims) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws, req) => {
    handleConnection(ws, { cfg, sessions });
  });

  return wss;
}

function handleConnection(ws, { cfg, sessions }) {
  let currentSession = null;
  const onData = (data) => {
    try {
      ws.send(JSON.stringify({ type: 'data', data: data.toString('utf8') }));
    } catch {
      /* client gone */
    }
  };
  const onExit = ({ exitCode, signal }) => {
    try {
      ws.send(JSON.stringify({ type: 'exit', exitCode, signal }));
    } catch {
      /* ignore */
    }
    detachCurrent();
  };
  const onTitle = (title) => {
    try {
      ws.send(JSON.stringify({ type: 'title', ...title }));
    } catch {
      /* ignore */
    }
  };

  function attach(session) {
    detachCurrent();
    currentSession = session;
    session.on('data', onData);
    session.on('exit', onExit);
    session.on('title', onTitle);
  }

  function detachCurrent() {
    if (!currentSession) return;
    currentSession.off('data', onData);
    currentSession.off('exit', onExit);
    currentSession.off('title', onTitle);
    currentSession = null;
  }

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(ws, { type: 'error', message: 'invalid json' });
    }

    try {
      switch (msg.type) {
        case 'ping':
          return send(ws, { type: 'pong' });

        case 'create': {
          const s = await sessions.createSession({
            cols: clampInt(msg.cols, 20, 400, 80),
            rows: clampInt(msg.rows, 5, 200, 24),
            title: typeof msg.title === 'string' ? msg.title.slice(0, 80) : null,
          });
          attach(s);
          send(ws, { type: 'created', session: s.describe() });
          // Flush any early buffered output
          const snap = s.buffer.snapshot();
          if (snap) send(ws, { type: 'data', data: snap });
          break;
        }

        case 'attach': {
          const s = sessions.getSession(msg.sessionId);
          if (!s) return send(ws, { type: 'error', message: 'no such session' });
          attach(s);
          if (msg.cols && msg.rows) {
            s.resize(clampInt(msg.cols, 20, 400, s.cols), clampInt(msg.rows, 5, 200, s.rows));
          }
          send(ws, {
            type: 'attached',
            session: s.describe(),
            snapshot: s.buffer.snapshot(),
          });
          break;
        }

        case 'input': {
          if (!currentSession) return send(ws, { type: 'error', message: 'not attached' });
          if (typeof msg.data !== 'string') return;
          currentSession.write(msg.data);
          break;
        }

        case 'resize': {
          if (!currentSession) return;
          currentSession.resize(
            clampInt(msg.cols, 20, 400, currentSession.cols),
            clampInt(msg.rows, 5, 200, currentSession.rows)
          );
          break;
        }

        case 'detach': {
          detachCurrent();
          send(ws, { type: 'detached' });
          break;
        }

        case 'close': {
          if (msg.sessionId) {
            await sessions.closeSession(msg.sessionId);
          } else if (currentSession) {
            const id = currentSession.id;
            detachCurrent();
            await sessions.closeSession(id);
          }
          send(ws, { type: 'closed' });
          break;
        }

        default:
          send(ws, { type: 'error', message: `unknown type: ${msg.type}` });
      }
    } catch (err) {
      send(ws, { type: 'error', message: err.message });
    }
  });

  ws.on('close', () => {
    detachCurrent();
  });

  ws.on('error', () => {
    detachCurrent();
  });
}

function send(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
}

function clampInt(n, min, max, fallback) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}
