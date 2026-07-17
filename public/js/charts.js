/**
 * Minimal SVG chart builders for the stats panels.
 * Series colors ride on CSS custom properties (--series-fwd / --series-rev)
 * so light/dark theming happens in the stylesheet, not here.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const MARGIN = { l: 36, r: 4, t: 8, b: 22 };
const SEG_GAP = 2; // surface gap between stacked segments / adjacent bars
const CAP_RADIUS = 4;

function el(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/** Round v up to a "nice" axis maximum (1/2/5 ladder). */
function niceMax(v) {
  if (v <= 4) return 4;
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (v <= m * mag) return m * mag;
  return 10 * mag;
}

/** Bar with a rounded top cap only — the baseline end stays square. */
function topCappedRect(x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`;
}

function tooltipFor(container) {
  let tip = container.querySelector('.viz-tooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'viz-tooltip';
    tip.hidden = true;
    container.append(tip);
  }
  return {
    show(x, y, html) {
      tip.innerHTML = html;
      tip.hidden = false;
      const half = tip.offsetWidth / 2;
      tip.style.left = `${Math.max(half, Math.min(x, container.clientWidth - half))}px`;
      tip.style.top = `${y}px`;
    },
    hide() {
      tip.hidden = true;
    },
  };
}

function grid(svg, plotW, plotH, yMax, ticks = 4) {
  for (let i = 0; i <= ticks; i++) {
    const y = MARGIN.t + plotH - (plotH * i) / ticks;
    if (i > 0) {
      svg.append(
        el('line', {
          x1: MARGIN.l, x2: MARGIN.l + plotW, y1: y, y2: y,
          stroke: 'var(--grid)', 'stroke-width': 1,
        })
      );
    }
    const label = el('text', {
      x: MARGIN.l - 6, y: y + 3.5, 'text-anchor': 'end',
      fill: 'var(--muted)', 'font-size': 11,
    });
    label.textContent = String(Math.round((yMax * i) / ticks));
    svg.append(label);
  }
  svg.append(
    el('line', {
      x1: MARGIN.l, x2: MARGIN.l + plotW,
      y1: MARGIN.t + plotH, y2: MARGIN.t + plotH,
      stroke: 'var(--baseline)', 'stroke-width': 1,
    })
  );
}

const rowHtml = (cls, name, value) =>
  `<div class="tt-row"><i class="chip ${cls}"></i>${name} <b>${value}</b></div>`;

/**
 * Stacked bar chart of history buckets: fwd on the baseline, rev stacked above.
 * @param {HTMLElement} container position:relative .chart element
 * @param {Array} buckets [{ ts, fwd, rev, total }]
 * @param {(ts: number) => string} formatLabel axis/tooltip label for a bucket
 */
export function renderStackedBars(container, buckets, formatLabel) {
  container.querySelector('svg')?.remove();
  container.querySelector('.chart-empty')?.remove();
  const width = Math.max(container.clientWidth, 320);
  const height = 220;
  const plotW = width - MARGIN.l - MARGIN.r;
  const plotH = height - MARGIN.t - MARGIN.b;
  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img' });
  const tip = tooltipFor(container);

  const yMax = niceMax(Math.max(0, ...buckets.map((b) => b.total)));
  grid(svg, plotW, plotH, yMax);

  const n = buckets.length;
  const step = plotW / Math.max(1, n);
  const barW = Math.max(1, Math.min(step - SEG_GAP, step * 0.82));
  const yOf = (v) => (v / yMax) * plotH;

  buckets.forEach((b, i) => {
    const x = MARGIN.l + i * step + (step - barW) / 2;
    const baseY = MARGIN.t + plotH;
    const hFwd = yOf(b.fwd);
    const hRev = yOf(b.rev);
    if (b.fwd > 0) {
      const capped = b.rev === 0; // topmost segment gets the rounded cap
      const shape = capped
        ? el('path', { d: topCappedRect(x, baseY - hFwd, barW, hFwd, CAP_RADIUS), fill: 'var(--series-fwd)' })
        : el('rect', { x, y: baseY - hFwd, width: barW, height: Math.max(1, hFwd - SEG_GAP), fill: 'var(--series-fwd)' });
      svg.append(shape);
    }
    if (b.rev > 0) {
      const y = baseY - hFwd - hRev;
      svg.append(el('path', { d: topCappedRect(x, y, barW, Math.max(1, hRev - (b.fwd > 0 ? SEG_GAP : 0)), CAP_RADIUS), fill: 'var(--series-rev)' }));
    }

    // Hover hit target: full column, wider than the mark.
    const hover = el('rect', {
      x: MARGIN.l + i * step, y: MARGIN.t, width: step, height: plotH,
      class: 'hover-col',
    });
    hover.addEventListener('pointerenter', () => {
      const topY = MARGIN.t + plotH - hFwd - hRev;
      tip.show(
        MARGIN.l + i * step + step / 2,
        Math.min(topY, MARGIN.t + plotH - 20),
        `<div class="tt-title">${formatLabel(b.ts)}</div>` +
          rowHtml('chip-fwd', 'forward', b.fwd) +
          rowHtml('chip-rev', 'reverse', b.rev) +
          `<div class="tt-row">total <b>${b.total}</b></div>`
      );
    });
    hover.addEventListener('pointerleave', tip.hide);
    svg.append(hover);
  });

  // Sparse x labels: first, last and up to 3 in between.
  const labelCount = Math.min(5, n);
  for (let i = 0; i < labelCount; i++) {
    const idx = labelCount === 1 ? 0 : Math.round((i * (n - 1)) / (labelCount - 1));
    const text = el('text', {
      x: MARGIN.l + idx * step + step / 2, y: height - 6,
      'text-anchor': i === 0 ? 'start' : i === labelCount - 1 ? 'end' : 'middle',
      fill: 'var(--muted)', 'font-size': 11,
    });
    text.textContent = formatLabel(buckets[idx].ts);
    svg.append(text);
  }

  container.append(svg);
  if (buckets.every((b) => b.total === 0)) {
    const empty = document.createElement('div');
    empty.className = 'chart-empty muted';
    empty.textContent = 'No cars counted in this range yet.';
    container.append(empty);
  }
}

/**
 * Single-series line + area sparkline with crosshair hover.
 * @param {Array} buckets [{ ts, total }]
 */
export function renderSparkline(container, buckets, formatLabel) {
  container.querySelector('svg')?.remove();
  const width = Math.max(container.clientWidth, 240);
  const height = 72;
  const pad = { l: 2, r: 2, t: 6, b: 4 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img' });
  const tip = tooltipFor(container);

  const yMax = niceMax(Math.max(0, ...buckets.map((b) => b.total)));
  const n = buckets.length;
  const xOf = (i) => pad.l + (n === 1 ? plotW / 2 : (i * plotW) / (n - 1));
  const yOf = (v) => pad.t + plotH - (v / yMax) * plotH;

  svg.append(el('line', {
    x1: pad.l, x2: pad.l + plotW, y1: pad.t + plotH, y2: pad.t + plotH,
    stroke: 'var(--baseline)', 'stroke-width': 1,
  }));

  const lineD = buckets.map((b, i) => `${i === 0 ? 'M' : 'L'}${xOf(i)},${yOf(b.total)}`).join(' ');
  const areaD = `${lineD} L${xOf(n - 1)},${pad.t + plotH} L${xOf(0)},${pad.t + plotH} Z`;
  svg.append(el('path', { d: areaD, fill: 'var(--series-fwd)', 'fill-opacity': 0.12, stroke: 'none' }));
  svg.append(el('path', {
    d: lineD, fill: 'none', stroke: 'var(--series-fwd)', 'stroke-width': 2,
    'stroke-linejoin': 'round', 'stroke-linecap': 'round',
  }));

  const crosshair = el('line', { y1: pad.t, y2: pad.t + plotH, stroke: 'var(--muted)', 'stroke-width': 1, visibility: 'hidden' });
  const dot = el('circle', { r: 4, fill: 'var(--series-fwd)', stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' });
  svg.append(crosshair, dot);

  const capture = el('rect', { x: 0, y: 0, width, height, fill: 'transparent' });
  capture.addEventListener('pointermove', (e) => {
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - pad.l) / plotW) * (n - 1))));
    const b = buckets[i];
    crosshair.setAttribute('x1', xOf(i));
    crosshair.setAttribute('x2', xOf(i));
    crosshair.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', xOf(i));
    dot.setAttribute('cy', yOf(b.total));
    dot.setAttribute('visibility', 'visible');
    tip.show(xOf(i), yOf(b.total), `<div class="tt-title">${formatLabel(b.ts)}</div><div class="tt-row">cars <b>${b.total}</b></div>`);
  });
  capture.addEventListener('pointerleave', () => {
    crosshair.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
    tip.hide();
  });
  svg.append(capture);
  container.append(svg);
}

/** Accessible table view of the same history buckets (most recent first). */
export function renderTable(container, buckets, formatLabel, cap = 120) {
  const rows = buckets.filter((b) => b.total > 0).reverse().slice(0, cap);
  if (rows.length === 0) {
    container.innerHTML = '<p class="muted">No data in this range.</p>';
    return;
  }
  const cells = rows
    .map((b) => `<tr><td>${formatLabel(b.ts)}</td><td>${b.fwd}</td><td>${b.rev}</td><td>${b.total}</td></tr>`)
    .join('');
  container.innerHTML = `<table class="data-table">
    <thead><tr><th>Time</th><th>Forward</th><th>Reverse</th><th>Total</th></tr></thead>
    <tbody>${cells}</tbody></table>
    ${buckets.filter((b) => b.total > 0).length > cap ? `<p class="muted">Showing the ${cap} most recent non-empty rows.</p>` : ''}`;
}
