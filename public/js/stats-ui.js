import { fetchSummary, fetchHistory, fetchSpeeds, fetchClasses } from './api.js';
import {
  renderStackedBars,
  renderSparkline,
  renderSpeedLine,
  renderTable,
  renderHistogram,
  renderClassMix,
} from './charts.js';

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
 * user's direction filter ('both' | 'fwd' | 'rev') applied to displayed
 * values. Options: `initial` restores a saved {bucket, rangeMs} view;
 * `onViewChange(bucket, rangeMs)` fires when the user changes it.
 */
export class StatsUi {
  #bucket = 'minute';
  #rangeMs = RANGES.minute[0][1];
  #lastHistory = null;

  constructor(refs, countMode, { initial, onViewChange, speedInfo } = {}) {
    this.refs = refs;
    this.countMode = countMode;
    this.onViewChange = onViewChange;
    this.speedInfo = speedInfo ?? (() => ({ active: false, limitKmh: 0 }));

    refs.bucketSeg.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-bucket]');
      if (!btn) return;
      this.setView(btn.dataset.bucket);
      this.onViewChange?.(this.#bucket, this.#rangeMs);
    });
    refs.rangeSelect.addEventListener('change', () => {
      this.#rangeMs = Number(refs.rangeSelect.value);
      this.refreshHistory();
      this.onViewChange?.(this.#bucket, this.#rangeMs);
    });
    this.#fillRangeOptions();
    if (initial) this.setView(initial.bucket, initial.rangeMs);

    new ResizeObserver(() => this.#rerenderHistory()).observe(refs.historyChart);

    this.refreshSummary();
    this.refreshHistory();
    this.refreshAnalytics();
    setInterval(() => this.refreshSummary(), SUMMARY_POLL_MS);
    setInterval(() => this.refreshHistory(), HISTORY_POLL_MS);
    setInterval(() => this.refreshAnalytics(), HISTORY_POLL_MS);
  }

  #lastSpeeds = null;

  #fillRangeOptions() {
    this.refs.rangeSelect.innerHTML = RANGES[this.#bucket]
      .map(([label, ms]) => `<option value="${ms}">${label}</option>`)
      .join('');
    this.#rangeMs = RANGES[this.#bucket][0][1];
  }

  /** Switch the history view (bucket and optionally range) programmatically. */
  setView(bucket, rangeMs) {
    if (!RANGES[bucket]) return;
    this.#bucket = bucket;
    for (const b of this.refs.bucketSeg.querySelectorAll('button')) {
      b.classList.toggle('active', b.dataset.bucket === bucket);
    }
    this.#fillRangeOptions();
    if (rangeMs && RANGES[bucket].some(([, ms]) => ms === rangeMs)) {
      this.#rangeMs = rangeMs;
      this.refs.rangeSelect.value = String(rangeMs);
    }
    this.refreshHistory();
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
    // "How many go backwards for every one that goes forward" — today.
    refs.dirRatio.textContent = s.today.fwd > 0 ? (s.today.rev / s.today.fwd).toFixed(2) : '–';

    const speedActive = this.speedInfo().active;
    refs.tileSpeedWrap.hidden = !speedActive;
    refs.tileOverWrap.hidden = !speedActive;
    if (speedActive && s.speed) {
      refs.tileSpeed.textContent = s.speed.last5Min.avgKmh ?? '–';
      refs.tileOver.textContent = s.speed.today.over;
    }
  }

  /** Deeper analytics on their own cadence: distribution, p85, class mix. */
  async refreshAnalytics() {
    const { refs } = this;
    const speedActive = this.speedInfo().active;
    try {
      const classes = await fetchClasses();
      renderClassMix(refs.classMix, classes.classes);
    } catch {}
    refs.tileP85Wrap.hidden = !speedActive;
    refs.tileMaxWrap.hidden = !speedActive;
    refs.speedHint.hidden = speedActive;
    if (!speedActive) return;
    try {
      const sp = await fetchSpeeds();
      this.#lastSpeeds = sp;
      refs.tileP85.textContent = sp.p85Kmh ?? '–';
      refs.tileMax.textContent = sp.maxKmh ?? '–';
      refs.tileOverLabel.textContent =
        sp.overPct != null ? `over limit · today (${sp.overPct}% of 24 h)` : 'over limit · today';
      if (!refs.speedHistogram.parentElement.hidden) {
        renderHistogram(refs.speedHistogram, sp.histogram, sp.limitKmh);
      }
    } catch {}
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
    const buckets = this.#lastHistory.buckets;
    renderStackedBars(this.refs.historyChart, buckets, fmt);
    renderTable(this.refs.historyTable, buckets, fmt);
    const { active, limitKmh } = this.speedInfo();
    const hasSpeed = active && buckets.some((b) => b.avgKmh != null);
    this.refs.speedHistory.hidden = !hasSpeed;
    if (hasSpeed) {
      renderSpeedLine(this.refs.speedChart, buckets, fmt, limitKmh);
      if (this.#lastSpeeds) {
        renderHistogram(this.refs.speedHistogram, this.#lastSpeeds.histogram, this.#lastSpeeds.limitKmh);
      }
    }
  }
}
