/**
 * Main-thread face of the counting engine. The engine itself runs in a
 * worker thread (spawned lazily on first start), so frame processing can
 * never add latency to HTTP handling. Status/track snapshots are pushed
 * here every 250 ms and served from memory; the preview stays a plain file
 * that ffmpeg writes and this thread reads directly.
 */
import { readFile, stat } from 'node:fs/promises';

const WORKER_URL = new URL('../worker/engine-worker.js', import.meta.url).href;
const IDLE_STATUS = { available: true, running: false, error: null, tracks: [] };

export class EngineProxy {
  #store;
  #worker = null;
  #status = { ...IDLE_STATUS };
  #previewPath = null;
  #pending = new Map();
  #nextId = 1;

  constructor(store) {
    this.#store = store;
  }

  #ensureWorker() {
    if (this.#worker) return;
    this.#worker = new Worker(WORKER_URL);
    this.#worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'status') {
        this.#status = { available: true, ...m.status };
      } else if (m.type === 'events') {
        try {
          this.#store.insertEvents(m.events);
        } catch (err) {
          console.error('[engine] event insert failed:', err.message);
        }
      } else if (m.type === 'getConfig') {
        this.#worker.postMessage({ type: 'config', id: m.id, config: this.#store.getConfig('app') ?? {} });
      } else if (m.type === 'previewPath') {
        this.#previewPath = m.path;
      } else if (m.type === 'reply') {
        const p = this.#pending.get(m.id);
        if (p) {
          this.#pending.delete(m.id);
          if (m.ok) {
            if (m.status) this.#status = { available: true, ...m.status };
            p.resolve();
          } else {
            p.reject(new Error(m.error));
          }
        }
      }
    };
    this.#worker.onerror = (e) => {
      this.#status = { ...IDLE_STATUS, error: `engine worker: ${e.message}` };
    };
  }

  #rpc(cmd, payload = {}) {
    this.#ensureWorker();
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ cmd, id, ...payload });
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`engine ${cmd} timed out`));
      }, 30_000);
    });
  }

  get status() {
    return this.#status;
  }

  async start(source) {
    await this.#rpc('start', { source });
  }

  async stop() {
    if (!this.#worker) return;
    await this.#rpc('stop');
  }

  applyConfig() {
    this.#worker?.postMessage({ cmd: 'applyConfig' });
  }

  async preview() {
    if (!this.#previewPath) return null;
    try {
      return await readFile(this.#previewPath);
    } catch {
      return null;
    }
  }

  async previewFrame(afterSeq = -1) {
    if (!this.#previewPath) return null;
    try {
      const info = await stat(this.#previewPath);
      if (info.mtimeMs <= afterSeq) return null;
      return { jpeg: await readFile(this.#previewPath), seq: info.mtimeMs };
    } catch {
      return null;
    }
  }

  async dispose() {
    try {
      await this.stop();
    } catch {}
    this.#worker?.terminate();
    this.#worker = null;
    this.#status = { ...IDLE_STATUS };
  }
}
