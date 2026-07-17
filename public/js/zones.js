import { signedDistance, pointInPolygon } from './geometry.js';

const CLICK_SLOP_PX = 4; // screen px of movement before a press becomes a drag

function makeId(prefix) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Interactive editor for counting lines and detection zones, all in video
 * pixel space:
 *   shapes = { lines: [{id, a, b}], zones: [{id, points}] }
 *
 * Modes:
 *  - null (edit mode): click selects a shape; drag its body to move it, drag
 *    an endpoint/vertex to reshape (which is how lines rotate/scale);
 *    Delete/Backspace removes the selection; Escape deselects. Drags that hit
 *    nothing are handed to `onPan` (camera panning while zoomed).
 *  - 'line': two clicks add a counting line.
 *  - 'zone': clicks add vertices; double-click/Enter closes; Escape cancels.
 *
 * The host owns persistence: `onChange(shapes)` fires on every mutation
 * (including live drags); `setShapes` replaces the working copy.
 */
export class ShapeEditor {
  mode = null;
  points = [];
  cursor = null;
  selection = null; // { kind: 'line'|'zone', id, handle: number|null }
  shapes = { lines: [], zones: [] };
  laneSplit = 0; // when > 1, the next drawn line becomes N per-lane segments
  #drag = null;

  constructor(canvas, { onChange, onSelect, onModeChange, onPan, onPanEnd, getView }) {
    this.canvas = canvas;
    this.onChange = onChange;
    this.onSelect = onSelect;
    this.onModeChange = onModeChange;
    this.onPan = onPan;
    this.onPanEnd = onPanEnd;
    this.getView = getView;

    canvas.addEventListener('pointerdown', (e) => this.#pointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.#pointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.#pointerUp(e));
    canvas.addEventListener('pointercancel', (e) => this.#pointerUp(e));
    canvas.addEventListener('dblclick', (e) => {
      e.preventDefault();
      this.#closeZone();
    });
    addEventListener('keydown', (e) => this.#keyDown(e));
  }

  setShapes(shapes) {
    this.shapes = shapes;
    if (this.selection && !this.#find(this.selection)) this.#select(null);
  }

  start(mode) {
    this.mode = mode;
    this.points = [];
    this.#select(null);
    this.onModeChange?.(mode);
  }

  cancel() {
    if (!this.mode) return;
    this.mode = null;
    this.points = [];
    this.cursor = null;
    this.onModeChange?.(null);
  }

  deleteSelection() {
    if (!this.selection) return;
    const { kind, id } = this.selection;
    if (kind === 'line') this.shapes.lines = this.shapes.lines.filter((l) => l.id !== id);
    else this.shapes.zones = this.shapes.zones.filter((z) => z.id !== id);
    this.#select(null);
    this.onChange?.(this.shapes);
  }

  /** Selected line, or the only line when nothing is selected. */
  targetLine() {
    if (this.selection?.kind === 'line') return this.#find(this.selection);
    return this.shapes.lines.length === 1 ? this.shapes.lines[0] : null;
  }

  flipTargetLine() {
    const line = this.targetLine();
    if (!line) return false;
    [line.a, line.b] = [line.b, line.a];
    this.onChange?.(this.shapes);
    return true;
  }

  #find({ kind, id }) {
    const list = kind === 'line' ? this.shapes.lines : this.shapes.zones;
    return list.find((s) => s.id === id) ?? null;
  }

  #select(selection) {
    this.selection = selection;
    this.onSelect?.(selection);
  }

  /**
   * Map a pointer event to full-frame video pixels. The canvas is never
   * CSS-zoomed; the zoom view (from getView) is applied here instead.
   */
  #toVideo(e) {
    const rect = this.canvas.getBoundingClientRect();
    const view = this.getView?.() ?? { z: 1, visX: 0, visY: 0, vw: 0, vh: 0 };
    const vw = view.vw || 1;
    const vh = view.vh || 1;
    const scale = Math.min(rect.width / vw, rect.height / vh);
    const offsetX = (rect.width - vw * scale) / 2;
    const offsetY = (rect.height - vh * scale) / 2;
    const u = {
      x: (e.clientX - rect.left - offsetX) / scale,
      y: (e.clientY - rect.top - offsetY) / scale,
    };
    return {
      x: Math.min(vw, Math.max(0, view.visX + u.x / view.z)),
      y: Math.min(vh, Math.max(0, view.visY + u.y / view.z)),
      pxScale: scale * view.z, // screen px per video px
    };
  }

  /** Hit-test with a constant ~10 screen px tolerance. */
  #hitTest(p) {
    const tol = 10 / p.pxScale;
    for (const line of this.shapes.lines) {
      if (Math.hypot(p.x - line.a.x, p.y - line.a.y) <= tol) return { kind: 'line', id: line.id, handle: 0 };
      if (Math.hypot(p.x - line.b.x, p.y - line.b.y) <= tol) return { kind: 'line', id: line.id, handle: 1 };
    }
    for (const zone of this.shapes.zones) {
      const hit = zone.points.findIndex((v) => Math.hypot(p.x - v.x, p.y - v.y) <= tol);
      if (hit !== -1) return { kind: 'zone', id: zone.id, handle: hit };
    }
    for (const line of this.shapes.lines) {
      const len = Math.hypot(line.b.x - line.a.x, line.b.y - line.a.y);
      const t = ((p.x - line.a.x) * (line.b.x - line.a.x) + (p.y - line.a.y) * (line.b.y - line.a.y)) / (len * len || 1);
      if (t >= 0 && t <= 1 && Math.abs(signedDistance(p, line.a, line.b)) <= tol) {
        return { kind: 'line', id: line.id, handle: null };
      }
    }
    for (const zone of this.shapes.zones) {
      if (pointInPolygon(p, zone.points)) return { kind: 'zone', id: zone.id, handle: null };
    }
    return null;
  }

  #pointerDown(e) {
    const p = this.#toVideo(e);
    if (this.mode) {
      this.#placePoint(p);
      return;
    }
    const hit = this.#hitTest(p);
    this.#select(hit);
    this.canvas.setPointerCapture(e.pointerId);
    this.#drag = {
      hit,
      startClient: { x: e.clientX, y: e.clientY },
      last: p,
      moved: false,
      panning: !hit && this.onPan != null,
    };
  }

  #pointerMove(e) {
    if (this.mode) {
      this.cursor = this.#toVideo(e);
      return;
    }
    if (!this.#drag) return;
    const drag = this.#drag;
    if (
      !drag.moved &&
      Math.hypot(e.clientX - drag.startClient.x, e.clientY - drag.startClient.y) < CLICK_SLOP_PX
    ) {
      return;
    }
    drag.moved = true;

    if (drag.panning) {
      const rect = this.canvas.getBoundingClientRect();
      this.onPan((drag.lastClient?.x ?? drag.startClient.x) - e.clientX, (drag.lastClient?.y ?? drag.startClient.y) - e.clientY, rect);
      drag.lastClient = { x: e.clientX, y: e.clientY };
      return;
    }
    if (!drag.hit) return;

    const p = this.#toVideo(e);
    const dx = p.x - drag.last.x;
    const dy = p.y - drag.last.y;
    drag.last = p;
    const shape = this.#find(drag.hit);
    if (!shape) return;
    if (drag.hit.kind === 'line') {
      if (drag.hit.handle === 0) shape.a = { x: p.x, y: p.y };
      else if (drag.hit.handle === 1) shape.b = { x: p.x, y: p.y };
      else {
        shape.a = { x: shape.a.x + dx, y: shape.a.y + dy };
        shape.b = { x: shape.b.x + dx, y: shape.b.y + dy };
      }
    } else {
      if (drag.hit.handle != null) shape.points[drag.hit.handle] = { x: p.x, y: p.y };
      else shape.points = shape.points.map((v) => ({ x: v.x + dx, y: v.y + dy }));
    }
    this.onChange?.(this.shapes);
  }

  #pointerUp() {
    if (!this.#drag) return;
    const { panning, moved } = this.#drag;
    this.#drag = null;
    if (panning && moved) this.onPanEnd?.();
    else if (moved) this.onChange?.(this.shapes);
  }

  #placePoint(p) {
    this.points.push({ x: p.x, y: p.y });
    if (this.mode === 'line' && this.points.length === 2) {
      const [a, b] = this.points;
      const lanes = this.laneSplit;
      this.laneSplit = 0;
      this.cancel();
      if (Math.hypot(b.x - a.x, b.y - a.y) <= 10) return;
      if (lanes > 1) {
        // Split a->b into per-lane segments with small gaps so a crossing
        // near a shared boundary can't fire two lanes at once.
        const gap = 0.06 / lanes;
        for (let i = 0; i < lanes; i++) {
          const t0 = i / lanes + (i === 0 ? 0 : gap / 2);
          const t1 = (i + 1) / lanes - (i === lanes - 1 ? 0 : gap / 2);
          const lerp = (t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
          this.shapes.lines.push({ id: makeId('line'), a: lerp(t0), b: lerp(t1) });
        }
        this.onChange?.(this.shapes);
        return;
      }
      const line = { id: makeId('line'), a, b };
      this.shapes.lines.push(line);
      this.#select({ kind: 'line', id: line.id, handle: null });
      this.onChange?.(this.shapes);
    }
  }

  #closeZone() {
    if (this.mode !== 'zone') return;
    const points = this.points;
    this.cancel();
    if (points.length >= 3) {
      const zone = { id: makeId('zone'), points };
      this.shapes.zones.push(zone);
      this.#select({ kind: 'zone', id: zone.id, handle: null });
      this.onChange?.(this.shapes);
    }
  }

  #keyDown(e) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === 'Escape') {
      if (this.mode) this.cancel();
      else this.#select(null);
    } else if (e.key === 'Enter' && this.mode === 'zone') {
      this.#closeZone();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && !this.mode) {
      this.deleteSelection();
    }
  }
}
