import { positiveNormal } from './geometry.js';

const LINE_COLOR = '#38bdf8';
const ROI_COLOR = '#fbbf24';
const TRACK_COLOR = 'rgba(248, 250, 252, 0.9)';
const TRAIL_COLOR = 'rgba(56, 189, 248, 0.6)';
const PULSE_MS = 700;

/**
 * Draws detections, trails, the counting line/zone and count pulses onto the
 * canvas stacked over the video. All inputs are in video pixel space; the
 * canvas is kept at the video's intrinsic resolution.
 */
export class Overlay {
  #pulses = []; // {x, y, direction, t}

  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  resize(width, height) {
    if (width && (this.canvas.width !== width || this.canvas.height !== height)) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  addPulse(x, y, direction) {
    this.#pulses.push({ x, y, direction, t: performance.now() });
  }

  /**
   * @param {object} s scene state:
   *   { tracks, line, roi, editing: {mode, points, cursor}, showBoxes }
   */
  draw(s) {
    const { ctx, canvas } = this;
    const scale = Math.max(1, canvas.width / 1280); // keep stroke widths legible
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (s.roi?.length >= 3) this.#drawRoi(s.roi, scale);
    if (s.editing?.mode === 'roi') this.#drawPending(s.editing, ROI_COLOR, scale, true);
    if (s.line) this.#drawLine(s.line, scale);
    if (s.editing?.mode === 'line') this.#drawPending(s.editing, LINE_COLOR, scale, false);
    if (s.showBoxes !== false) for (const t of s.tracks ?? []) this.#drawTrack(t, scale);
    this.#drawPulses(scale);
  }

  #drawRoi(roi, scale) {
    const { ctx } = this;
    ctx.beginPath();
    roi.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(251, 191, 36, 0.08)';
    ctx.fill();
    ctx.strokeStyle = ROI_COLOR;
    ctx.lineWidth = 1.5 * scale;
    ctx.setLineDash([8 * scale, 6 * scale]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  #drawLine(line, scale) {
    const { ctx } = this;
    const { a, b } = line;
    ctx.strokeStyle = LINE_COLOR;
    ctx.fillStyle = LINE_COLOR;
    ctx.lineWidth = 3 * scale;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    for (const p of [a, b]) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5 * scale, 0, Math.PI * 2);
      ctx.fill();
    }
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
    this.#label('forward', tip.x, tip.y - 10 * scale, LINE_COLOR, scale);
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

  #drawTrack(t, scale) {
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
      this.#label(`${t.class} #${t.id}`, x, y - 6 * scale, TRACK_COLOR, scale);
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
