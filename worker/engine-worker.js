/**
 * Worker-thread host for the CountingEngine. All heavy per-frame work (CHW
 * conversion, tensor marshaling, decode) happens here, so the server's HTTP
 * event loop never blocks. The main thread owns the Store; config reads and
 * event writes flow over messages.
 */
import { CountingEngine } from './engine.js';

const pendingConfig = new Map();
let configRequestId = 0;

const engine = new CountingEngine({
  getConfig: () =>
    new Promise((resolve) => {
      const id = ++configRequestId;
      pendingConfig.set(id, resolve);
      postMessage({ type: 'getConfig', id });
    }),
  postEvents: (events) => postMessage({ type: 'events', events }),
});

postMessage({ type: 'previewPath', path: engine.previewPath });
setInterval(() => postMessage({ type: 'status', status: engine.status }), 250);

onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'config') {
    pendingConfig.get(m.id)?.(m.config);
    pendingConfig.delete(m.id);
    return;
  }
  if (!m.cmd) return;
  try {
    if (m.cmd === 'start') await engine.start(m.source);
    else if (m.cmd === 'stop') await engine.stop();
    else if (m.cmd === 'applyConfig') engine.applyConfig();
    if (m.id != null) postMessage({ type: 'reply', id: m.id, ok: true, status: engine.status });
  } catch (err) {
    if (m.id != null) postMessage({ type: 'reply', id: m.id, ok: false, error: err.message });
  }
};
