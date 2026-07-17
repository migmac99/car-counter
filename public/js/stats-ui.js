import { fetchSummary, fetchHistory } from './api.js';
import { renderStackedBars, renderSparkline, renderTable } from './charts.js';

const SUMMARY_POLL_MS = 4000;
const HISTORY_POLL_MS = 15_000;

const RANGES = {
  minute: [
    ['30 min', 30 * 60_000],
    ['1 hour', 3600_000],
    ['3 hours', 3 * 3600_000],
    ['6 hours', 6 * 3600_000],
  ],
  hour: [
    ['12 hours', 12 * 3600_000],
    ['24 hours', 86_400_000],
    ['48 hours', 2 * 86_400_000],
    ['7 days', 7 * 86_400_000],
  ],
  day: [
    ['7 days', 7 * 86_400_000],
    ['30 days', 30 * 86_400_000],
    ['90 days', 90 * 86_400_000],
  ],
};

const timeFmt = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric' });
const dayTimeFmt = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function labelFormatter(bucket, rangeMs) {
  if (bucket === 'day') return (ts) => dayFmt.format(ts);
  if (rangeMs > 86_400_000) return (ts) => dayTimeFmt.format(ts);
  return (ts) => timeFmt.format(ts);
}

/**
 * Owns the live tiles, sparkline and history chart. `countMode()` supplies the
 * user's direction filter ('both' | 'fwd' | 'rev') applied to displayed values.
 */
export class StatsUi {
  #bucket = 'minute';
  #rangeMs = RANGES.minute[0][1];
  #lastHistory = null;

  constructor(refs, countMode) {
    this.refs = refs;
    this.countMode = countMode;

    refs.bucketSeg.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-bucket]');
      if (!btn) return;
      this.#bucket = btn.dataset.bucket;
      for (const b of refs.bucketSeg.querySelectorAll('button')) {
        b.classList.toggle('active', b === btn);
      }
      this.#fillRangeOptions();
      this.refreshHistory();
    });
    refs.rangeSelect.addEventListener('change', () => {
      this.#rangeMs = Number(refs.rangeSelect.value);
      this.refreshHistory();
    });
    this.#fillRangeOptions();

    new ResizeObserver(() => this.#rerenderHistory()).observe(refs.historyChart);

    this.refreshSummary();
    this.refreshHistory();
    setInterval(() => this.refreshSummary(), SUMMARY_POLL_MS);
    setInterval(() => this.refreshHistory(), HISTORY_POLL_MS);
  }

  #fillRangeOptions() {
    this.refs.rangeSelect.innerHTML = RANGES[this.#bucket]
      .map(([label, ms]) => `<option value="${ms}">${label}</option>`)
      .join('');
    this.#rangeMs = RANGES[this.#bucket][0][1];
  }

  /** Instant feedback for a local crossing before the next server poll. */
  bump(direction) {
    const { refs } = this;
    const num = (el) => Number(el.textContent) || 0;
    if (this.#counts({ fwd: direction === 'fwd' ? 1 : 0, rev: direction === 'rev' ? 1 : 0 }) > 0) {
      refs.tileToday.textContent = num(refs.tileToday) + 1;
      refs.tileTotal.textContent = num(refs.tileTotal) + 1;
      refs.tileHour.textContent = num(refs.tileHour) + 1;
    }
    refs.dirFwd.textContent = num(refs.dirFwd) + (direction === 'fwd' ? 1 : 0);
    refs.dirRev.textContent = num(refs.dirRev) + (direction === 'rev' ? 1 : 0);
  }

  /** Direction-filtered count of a {fwd, rev} pair. */
  #counts(pair) {
    const mode = this.countMode();
    if (mode === 'fwd') return pair.fwd;
    if (mode === 'rev') return pair.rev;
    return pair.fwd + pair.rev;
  }

  async refreshSummary() {
    let s;
    try {
      s = await fetchSummary();
    } catch {
      return; // offline: keep last values
    }
    const { refs } = this;
    refs.tileCpm.textContent = this.#counts(s.perMinute);
    refs.tileRate5.textContent = (this.#counts(s.per5Min) / 5).toFixed(1);
    refs.tileHour.textContent = this.#counts(s.lastHour);
    refs.tileToday.textContent = this.#counts(s.today);
    refs.tileTotal.textContent = this.#counts(s.allTime);
    refs.dirFwd.textContent = s.today.fwd;
    refs.dirRev.textContent = s.today.rev;
  }

  async refreshHistory() {
    const now = Date.now();
    try {
      const [main, spark] = await Promise.all([
        fetchHistory(this.#bucket, now - this.#rangeMs, now),
        fetchHistory('minute', now - 30 * 60_000, now),
      ]);
      this.#lastHistory = main;
      this.#rerenderHistory();
      renderSparkline(this.refs.sparkline, spark.buckets, labelFormatter('minute', 0));
    } catch {
      // offline: keep last rendered charts
    }
  }

  #rerenderHistory() {
    if (!this.#lastHistory) return;
    const fmt = labelFormatter(this.#bucket, this.#rangeMs);
    renderStackedBars(this.refs.historyChart, this.#lastHistory.buckets, fmt);
    renderTable(this.refs.historyTable, this.#lastHistory.buckets, fmt);
  }
}
