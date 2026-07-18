import { positiveNormal } from './geometry.js';

const LINE_COLOR = '#38bdf8';
const SELECTED_COLOR = '#fbbf24';
const ROI_COLOR = '#fbbf24';
const TRACK_COLOR = 'rgba(248, 250, 252, 0.9)';
const TRAIL_COLOR = 'rgba(56, 189, 248, 0.6)';
const PULSE_MS = 700;

/**
 * Draws detections, trails, counting lines, zones and count pulses onto the
 * canvas stacked over the video. All inputs are in video pixel space; the
 * canvas is kept at the video's intrinsic resolution.
 */
export class Overlay {
  #pulses = []; // {x, y, direction, t}

  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  /** Match the backing store to the displayed size so strokes are pixel-crisp. */
  resize() {
    const dpr = devicePixelRatio || 1;
    const w = Math.round(this.canvas.clientWidth * dpr);
    const h = Math.round(this.canvas.clientHeight * dpr);
    if (w && (this.canvas.width !== w || this.canvas.height !== h)) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  addPulse(x, y, direction) {
    this.#pulses.push({ x, y, direction, t: performance.now() });
  }

  /**
   * @param {object} s scene state:
   *   { tracks, lines: [{id,a,b}], zones: [{id,points}], selection,
   *     editing: {mode, points, cursor}, view: {z, visX, visY}, showBoxes }
   *
   * The canvas itself is never CSS-zoomed (that would blur it); instead the
   * zoom view is applied here as a canvas transform, so lines, boxes and
   * labels re-rasterize crisply at any zoom while inputs stay in full-frame
   * video coordinates.
   */
  draw(s) {
    const { ctx, canvas } = this;
    const view = s.view ?? { z: 1, visX: 0, visY: 0, vw: 0, vh: 0 };
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!view.vw) return;
    // Letterbox the video's aspect into the canvas, then apply the zoom view:
    // one transform maps video coordinates to crisp device pixels.
    const s0 = Math.min(canvas.width / view.vw, canvas.height / view.vh);
    const ox = (canvas.width - view.vw * s0) / 2;
    const oy = (canvas.height - view.vh * s0) / 2;
    const k = view.z * s0;
    ctx.setTransform(k, 0, 0, k, ox - view.visX * k, oy - view.visY * k);
    // `scale` converts our CSS-px design sizes into pre-transform units so
    // strokes and labels render at constant screen size at any zoom.
    const scale = (devicePixelRatio || 1) / k;

    const isSelected = (kind, id) => s.selection?.kind === kind && s.selection?.id === id;
    // Focus mode: darken everything outside the zones — a literal picture
    // of "only what's inside the zones is tracked". Even-odd fill of the
    // screen rect (device space) minus the zone polygons (video space).
    if (s.dimOutside && (s.zones ?? []).some((z) => z.points.length >= 3)) {
      ctx.save();
      ctx.beginPath();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.rect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(k, 0, 0, k, ox - view.visX * k, oy - view.visY * k);
      for (const zone of s.zones) {
        if (zone.points.length < 3) continue;
        zone.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.closePath();
      }
      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.fill('evenodd');
      ctx.restore();
    }
    for (const zone of s.zones ?? []) this.#drawZone(zone, isSelected('zone', zone.id), scale);
    if (s.editing?.mode === 'zone') this.#drawPending(s.editing, ROI_COLOR, scale, true);
    (s.lines ?? []).forEach((line, i) =>
      this.#drawLine(line, i, isSelected('line', line.id), scale)
    );
    if (s.editing?.mode === 'line') this.#drawPending(s.editing, LINE_COLOR, scale, false);
    if (s.showBoxes !== false) for (const t of s.tracks ?? []) this.#drawTrack(t, scale);
    this.#drawPulses(scale);
  }

  #handle(p, color, scale) {
    const { ctx } = this;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5.5 * scale, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 1.5 * scale;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.stroke();
  }

  #drawZone(zone, selected, scale) {
    const { ctx } = this;
    const pts = zone.points;
    if (pts.length < 3) return;
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(251, 191, 36, 0.08)';
    ctx.fill();
    ctx.strokeStyle = ROI_COLOR;
    ctx.lineWidth = (selected ? 2.5 : 1.5) * scale;
    ctx.setLineDash(selected ? [] : [8 * scale, 6 * scale]);
    ctx.stroke();
    ctx.setLineDash([]);
    if (selected) for (const p of pts) this.#handle(p, ROI_COLOR, scale);
  }

  #drawLine(line, index, selected, scale) {
    const { ctx } = this;
    const { a, b } = line;
    const color = selected ? SELECTED_COLOR : LINE_COLOR;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = (selected ? 4 : 3) * scale;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    for (const p of [a, b]) this.#handle(p, color, scale);

    // Direction arrow at the midpoint, pointing to the 'forward' side.
    const n = positiveNormal(a, b);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const len = 34 * scale;
    const tip = { x: mid.x + n.x * len, y: mid.y + n.y * len };
    ctx.lineWidth = 2.5 * scale;
    ctx.beginPath();
    ctx.moveTo(mid.x, mid.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.stroke();
    const head = 9 * scale;
    const ang = Math.atan2(n.y, n.x);
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(tip.x - head * Math.cos(ang - 0.45), tip.y - head * Math.sin(ang - 0.45));
    ctx.lineTo(tip.x - head * Math.cos(ang + 0.45), tip.y - head * Math.sin(ang + 0.45));
    ctx.closePath();
    ctx.fill();
    this.#label(`L${index + 1} forward`, tip.x, tip.y - 10 * scale, color, scale);
  }

  #drawPending(editing, color, scale, closeable) {
    const { ctx } = this;
    const pts = editing.points;
    if (pts.length === 0 && !editing.cursor) return;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2 * scale;
    ctx.setLineDash([6 * scale, 5 * scale]);
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    if (editing.cursor && pts.length > 0) ctx.lineTo(editing.cursor.x, editing.cursor.y);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4.5 * scale, 0, Math.PI * 2);
      ctx.fill();
    }
    if (closeable && pts.length >= 3) {
      this.#label('double-click to close', pts[pts.length - 1].x, pts[pts.length - 1].y - 12 * scale, color, scale);
    }
  }

  #drawTrack(track, scale) {
    // Browser-pipeline tracks carry a smoothed display box; engine
    // snapshots arrive pre-smoothed.
    const t = track.display ? { ...track, bbox: track.display } : track;
    const { ctx } = this;
    const [x, y, w, h] = t.bbox;
    ctx.strokeStyle = t.confirmed ? TRACK_COLOR : 'rgba(248, 250, 252, 0.35)';
    ctx.lineWidth = 2 * scale;
    ctx.strokeRect(x, y, w, h);
    if (t.history.length > 1) {
      ctx.strokeStyle = TRAIL_COLOR;
      ctx.lineWidth = 2 * scale;
      ctx.beginPath();
      t.history.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
    }
    if (t.confirmed) {
      // Measured (gate-pair) speed is exact; the calibrated per-track
      // estimate is prefixed with ~.
      const speed =
        t.kmh != null
          ? ` · ${t.kmh} km/h`
          : t.estKmh != null
            ? ` · ~${Math.round(t.estKmh)} km/h`
            : '';
      const color = t.over ? '#f87171' : TRACK_COLOR;
      this.#label(`${t.class} #${t.id}${speed}`, x, y - 6 * scale, color, scale);
    }
  }

  #drawPulses(scale) {
    const { ctx } = this;
    const now = performance.now();
    this.#pulses = this.#pulses.filter((p) => now - p.t < PULSE_MS);
    for (const p of this.#pulses) {
      const age = (now - p.t) / PULSE_MS;
      ctx.strokeStyle = p.direction === 'fwd' ? 'rgba(56,189,248,' : 'rgba(74,222,128,';
      ctx.strokeStyle += `${1 - age})`;
      ctx.lineWidth = 3 * scale;
      ctx.beginPath();
      ctx.arc(p.x, p.y, (10 + age * 30) * scale, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  #label(text, x, y, color, scale) {
    const { ctx } = this;
    ctx.font = `${12 * scale}px system-ui, sans-serif`;
    const w = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(x - 3 * scale, y - 12 * scale, w + 6 * scale, 16 * scale);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }
}
