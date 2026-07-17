/**
 * Interactive editor for the counting line and the detection zone (ROI).
 * Converts pointer positions on the scaled canvas into video pixel space.
 * Line: two clicks. Zone: clicks add vertices, double-click/Enter closes,
 * Escape cancels either mode.
 */
export class ZoneEditor {
  mode = null; // null | 'line' | 'roi'
  points = [];
  cursor = null;

  /**
   * @param {HTMLCanvasElement} canvas overlay canvas (intrinsic = video size)
   * @param {object} callbacks { onLine(line), onRoi(roi|null), onModeChange(mode) }
   */
  constructor(canvas, { onLine, onRoi, onModeChange }) {
    this.canvas = canvas;
    this.onLine = onLine;
    this.onRoi = onRoi;
    this.onModeChange = onModeChange;

    canvas.addEventListener('click', (e) => this.#click(e));
    canvas.addEventListener('dblclick', (e) => {
      e.preventDefault();
      this.#closeRoi();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (this.mode) this.cursor = this.#toVideo(e);
    });
    canvas.addEventListener('pointerleave', () => (this.cursor = null));
    addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.cancel();
      if (e.key === 'Enter' && this.mode === 'roi') this.#closeRoi();
    });
  }

  start(mode) {
    this.mode = mode;
    this.points = [];
    this.onModeChange?.(mode);
  }

  cancel() {
    if (!this.mode) return;
    this.mode = null;
    this.points = [];
    this.cursor = null;
    this.onModeChange?.(null);
  }

  /** Map a pointer event on the letterboxed (object-fit: contain) canvas to video pixels. */
  #toVideo(e) {
    const rect = this.canvas.getBoundingClientRect();
    const vw = this.canvas.width;
    const vh = this.canvas.height;
    const scale = Math.min(rect.width / vw, rect.height / vh);
    const offsetX = (rect.width - vw * scale) / 2;
    const offsetY = (rect.height - vh * scale) / 2;
    return {
      x: Math.min(vw, Math.max(0, (e.clientX - rect.left - offsetX) / scale)),
      y: Math.min(vh, Math.max(0, (e.clientY - rect.top - offsetY) / scale)),
    };
  }

  #click(e) {
    if (!this.mode) return;
    const p = this.#toVideo(e);
    this.points.push(p);
    if (this.mode === 'line' && this.points.length === 2) {
      const [a, b] = this.points;
      this.mode = null;
      this.points = [];
      this.onModeChange?.(null);
      if (Math.hypot(b.x - a.x, b.y - a.y) > 10) this.onLine?.({ a, b });
    }
  }

  #closeRoi() {
    if (this.mode !== 'roi') return;
    const pts = this.points;
    this.mode = null;
    this.points = [];
    this.onModeChange?.(null);
    this.onRoi?.(pts.length >= 3 ? pts : null);
  }
}
