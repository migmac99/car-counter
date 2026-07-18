/** Server API client with an offline-tolerant, localStorage-backed event queue. */

const QUEUE_KEY = 'car-counter.event-queue';
const MAX_QUEUE = 5000;
const FLUSH_INTERVAL_MS = 3000;
const BATCH = 200;

function loadQueue() {
  try {
    const q = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]');
    return Array.isArray(q) ? q : [];
  } catch {
    return [];
  }
}

export class EventSink {
  #queue = loadQueue();
  #flushing = false;

  constructor() {
    setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    addEventListener('online', () => this.flush());
  }

  get pending() {
    return this.#queue.length;
  }

  record(event) {
    this.#queue.push(event);
    if (this.#queue.length > MAX_QUEUE) this.#queue.splice(0, this.#queue.length - MAX_QUEUE);
    this.#persist();
  }

  #persist() {
    try {
      localStorage.setItem(QUEUE_KEY, JSON.stringify(this.#queue));
    } catch {
      // storage full/unavailable: events stay in memory only
    }
  }

  async flush() {
    if (this.#flushing || this.#queue.length === 0) return;
    this.#flushing = true;
    try {
      while (this.#queue.length > 0) {
        const batch = this.#queue.slice(0, BATCH);
        const res = await fetch('/api/events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ events: batch }),
        });
        if (res.status === 400) {
          // Batch is malformed and will never succeed; drop it rather than wedge the queue.
          console.warn('dropping rejected event batch:', await res.text());
        } else if (!res.ok) {
          return; // server/network trouble: retry next interval
        }
        this.#queue.splice(0, batch.length);
        this.#persist();
      }
    } catch {
      // offline: retry next interval
    } finally {
      this.#flushing = false;
    }
  }
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

export const fetchSummary = () => getJson('/api/stats/summary');

export const fetchHistory = (bucket, from, to) => {
  const params = new URLSearchParams({ bucket });
  if (from != null) params.set('from', String(from));
  if (to != null) params.set('to', String(to));
  return getJson(`/api/stats/history?${params}`);
};

export const fetchSpeeds = () => getJson('/api/stats/speeds');

export const fetchClasses = () => getJson('/api/stats/classes');

export const fetchConfig = () => getJson('/api/config');

let saveTimer = null;
/** Debounced config persistence; the last call within 800ms wins. */
export function saveConfig(config) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    }).catch(() => {});
  }, 800);
}

export const resetHistory = () =>
  fetch('/api/events?confirm=yes', { method: 'DELETE' }).then((r) => r.json());

// --- named config presets ---

export const fetchPresets = () => getJson('/api/presets');

export const fetchPreset = (name) => getJson(`/api/preset?name=${encodeURIComponent(name)}`);

export async function savePreset(name, config) {
  const res = await fetch(`/api/preset?name=${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? 'save failed');
}

export const deletePreset = (name) =>
  fetch(`/api/preset?name=${encodeURIComponent(name)}`, { method: 'DELETE' });

// --- server-side counting engine ---

export const fetchEngine = () => getJson('/api/engine');

export async function setEngine(body) {
  const res = await fetch('/api/engine', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `engine -> ${res.status}`);
  return data;
}
