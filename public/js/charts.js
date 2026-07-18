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

/**
 * Average-speed line over history buckets (gaps where no measurement), with
 * an optional speed-limit reference hairline. Same x-domain as the bars.
 * @param {Array} buckets [{ ts, avgKmh, over }]
 */
export function renderSpeedLine(container, buckets, formatLabel, limitKmh = 0) {
  container.querySelector('svg')?.remove();
  const width = Math.max(container.clientWidth, 320);
  const height = 130;
  const plotW = width - MARGIN.l - MARGIN.r;
  const plotH = height - MARGIN.t - MARGIN.b;
  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img' });
  const tip = tooltipFor(container);

  const values = buckets.map((b) => b.avgKmh).filter((v) => v != null);
  const yMax = niceMax(Math.max(limitKmh, 0, ...values));
  grid(svg, plotW, plotH, yMax, 3);

  const n = buckets.length;
  const step = plotW / Math.max(1, n);
  const xOf = (i) => MARGIN.l + i * step + step / 2;
  const yOf = (v) => MARGIN.t + plotH - (v / yMax) * plotH;

  if (limitKmh > 0) {
    svg.append(el('line', {
      x1: MARGIN.l, x2: MARGIN.l + plotW, y1: yOf(limitKmh), y2: yOf(limitKmh),
      stroke: 'var(--danger)', 'stroke-width': 1, 'stroke-dasharray': '5 4',
    }));
    const lbl = el('text', {
      x: MARGIN.l + plotW, y: yOf(limitKmh) - 4, 'text-anchor': 'end',
      fill: 'var(--danger)', 'font-size': 10,
    });
    lbl.textContent = `limit ${limitKmh}`;
    svg.append(lbl);
  }

  // Line with gaps where no vehicle was measured
  let d = '';
  let pen = false;
  buckets.forEach((b, i) => {
    if (b.avgKmh == null) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${xOf(i)},${yOf(b.avgKmh)} `;
    pen = true;
  });
  svg.append(el('path', {
    d: d.trim(), fill: 'none', stroke: 'var(--series-fwd)', 'stroke-width': 2,
    'stroke-linejoin': 'round', 'stroke-linecap': 'round',
  }));
  // Mark buckets with over-limit vehicles
  buckets.forEach((b, i) => {
    if (b.avgKmh != null && b.over > 0) {
      svg.append(el('circle', { cx: xOf(i), cy: yOf(b.avgKmh), r: 4, fill: 'var(--danger)', stroke: 'var(--surface)', 'stroke-width': 2 }));
    }
  });

  buckets.forEach((b, i) => {
    if (b.avgKmh == null) return;
    const hover = el('rect', { x: MARGIN.l + i * step, y: MARGIN.t, width: step, height: plotH, class: 'hover-col' });
    hover.addEventListener('pointerenter', () => {
      tip.show(
        xOf(i),
        yOf(b.avgKmh),
        `<div class="tt-title">${formatLabel(b.ts)}</div>` +
          `<div class="tt-row">avg <b>${b.avgKmh} km/h</b></div>` +
          (b.over > 0 ? `<div class="tt-row">over limit <b>${b.over}</b></div>` : '')
      );
    });
    hover.addEventListener('pointerleave', tip.hide);
    svg.append(hover);
  });

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

/**
 * Speed distribution histogram (5 km/h bins) with the limit as a dashed
 * reference line. Single series — magnitude only, so one hue and no legend.
 * @param {Array} bins [{ fromKmh, toKmh, n }]
 */
export function renderHistogram(container, bins, limitKmh = 0) {
  container.querySelector('svg')?.remove();
  container.querySelector('.chart-empty')?.remove();
  const width = Math.max(container.clientWidth, 320);
  const height = 130;
  const plotW = width - MARGIN.l - MARGIN.r;
  const plotH = height - MARGIN.t - MARGIN.b;
  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img' });
  const tip = tooltipFor(container);

  if (bins.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'chart-empty muted';
    empty.textContent = 'No speed measurements yet.';
    container.append(svg);
    container.append(empty);
    return;
  }
  // Continuous km/h x-domain, padded one bin each side.
  const binW = bins[0].toKmh - bins[0].fromKmh;
  const x0 = Math.max(0, bins[0].fromKmh - binW);
  const x1 = Math.max(bins.at(-1).toKmh + binW, limitKmh + binW);
  const yMax = niceMax(Math.max(0, ...bins.map((b) => b.n)));
  grid(svg, plotW, plotH, yMax, 3);
  const xOf = (kmh) => MARGIN.l + ((kmh - x0) / (x1 - x0)) * plotW;
  const yOf = (v) => MARGIN.t + plotH - (v / yMax) * plotH;

  for (const b of bins) {
    const x = xOf(b.fromKmh) + SEG_GAP / 2;
    const w = Math.max(1, xOf(b.toKmh) - xOf(b.fromKmh) - SEG_GAP);
    const h = plotH - (yOf(b.n) - MARGIN.t);
    svg.append(
      el('path', {
        d: topCappedRect(x, yOf(b.n), w, Math.max(1, h), CAP_RADIUS),
        fill: 'var(--series-fwd)',
      })
    );
    const hover = el('rect', { x: xOf(b.fromKmh), y: MARGIN.t, width: xOf(b.toKmh) - xOf(b.fromKmh), height: plotH, class: 'hover-col' });
    hover.addEventListener('pointerenter', () =>
      tip.show(
        xOf(b.fromKmh + binW / 2),
        yOf(b.n),
        `<div class="tt-title">${b.fromKmh}–${b.toKmh} km/h</div><div class="tt-row">vehicles <b>${b.n}</b></div>`
      )
    );
    hover.addEventListener('pointerleave', tip.hide);
    svg.append(hover);
  }

  if (limitKmh > 0) {
    svg.append(el('line', {
      x1: xOf(limitKmh), x2: xOf(limitKmh), y1: MARGIN.t, y2: MARGIN.t + plotH,
      stroke: 'var(--danger)', 'stroke-width': 1, 'stroke-dasharray': '5 4',
    }));
    const lbl = el('text', {
      x: xOf(limitKmh) + 4, y: MARGIN.t + 10, fill: 'var(--danger)', 'font-size': 10,
    });
    lbl.textContent = `limit ${limitKmh}`;
    svg.append(lbl);
  }

  // x axis: km/h ticks at nice intervals
  const tickStep = x1 - x0 > 120 ? 40 : 20;
  for (let v = Math.ceil(x0 / tickStep) * tickStep; v <= x1; v += tickStep) {
    const t = el('text', {
      x: xOf(v), y: height - 6, 'text-anchor': 'middle', fill: 'var(--muted)', 'font-size': 11,
    });
    t.textContent = String(v);
    svg.append(t);
  }
  container.append(svg);
}

// Fixed class→slot assignment: color follows the entity, never the rank.
const CLASS_SLOTS = { car: 1, truck: 2, bus: 3, motorcycle: 4 };

/**
 * Vehicle-class mix as labeled proportion bars (HTML, not SVG — each row
 * carries its name and count, so identity is never color-alone).
 * @param {Array} classes [{ class, total }]
 */
export function renderClassMix(container, classes) {
  const total = classes.reduce((a, c) => a + c.total, 0);
  if (total === 0) {
    container.innerHTML = '';
    container.hidden = true;
    return;
  }
  container.hidden = false;
  container.innerHTML = classes
    .filter((c) => c.total > 0)
    .map((c) => {
      const slot = CLASS_SLOTS[c.class] ?? 4;
      const pct = (c.total / total) * 100;
      return `<div class="class-row">
        <span class="class-name"><i class="chip chip-cat-${slot}"></i>${c.class}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${pct.toFixed(1)}%;background:var(--series-${slot === 1 ? 'fwd' : slot === 2 ? 'rev' : slot})"></span></span>
        <span class="class-n">${c.total}</span>
      </div>`;
    })
    .join('');
}
