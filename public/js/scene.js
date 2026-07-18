/**
 * Scene-aware tracking tuning, shared by the browser pipeline and the
 * server engine. At night vehicles are essentially headlight blobs: the
 * detector scores real cars lower (so the association threshold relaxes),
 * while flickery lights demand MORE evidence before a track is believed
 * (higher minHits), heavier centroid smoothing, longer track memory and a
 * wider crossing dead-band.
 */

// Mean luma (0-255) with hysteresis so dusk doesn't flap the mode.
// Calibrated against a real road band: overcast daylight with heavy bridge
// shadow measures ~68-76, real night far below 40. The old 65/90 band put
// daylight scenes INSIDE the hysteresis dead zone — one cloudy dip latched
// night mode until sunset.
export const NIGHT_ENTER_LUMA = 45;
export const NIGHT_EXIT_LUMA = 70;

/** Fold a new luma sample into a night/day decision with hysteresis. */
export function nightFromLuma(meanLuma, wasNight) {
  if (meanLuma < NIGHT_ENTER_LUMA) return true;
  if (meanLuma > NIGHT_EXIT_LUMA) return false;
  return wasNight;
}

/** Resolve the user's scene setting against the measured state. */
export function effectiveNight(sceneMode, measuredNight) {
  if (sceneMode === 'night') return true;
  if (sceneMode === 'day') return false;
  return measuredNight; // 'auto'
}

/**
 * Night/day decision with hysteresis AND dwell: a flipped luma reading must
 * persist for `dwellMs` before the mode actually changes. Plain hysteresis
 * is not enough when luma is sampled over the road band — at night every
 * passing car's headlights spike the mean above the day threshold for a
 * couple of seconds, and each spike would retune tracking mid-vehicle.
 * Dusk and dawn are gradual, so a real transition always outlasts the
 * dwell.
 */
export class SceneState {
  constructor(dwellMs = 10_000, night = false) {
    this.dwellMs = dwellMs;
    this.night = night;
    this.candidate = null;
    this.since = 0;
  }

  update(luma, now) {
    const measured = nightFromLuma(luma, this.night);
    if (measured === this.night) {
      this.candidate = null;
      return this.night;
    }
    if (this.candidate !== measured) {
      this.candidate = measured;
      this.since = now;
    }
    if (now - this.since >= this.dwellMs) {
      this.night = measured;
      this.candidate = null;
    }
    return this.night;
  }
}

/**
 * Focus metric: variance of the Laplacian over the green channel (sparse
 * grid). Defocus crushes local second derivatives, so a sharp scene scores
 * an order of magnitude above a blurred one; the absolute value is
 * scene-dependent, so consumers compare against their own rolling baseline.
 */
export function sharpness(data, w, h, channels = 3) {
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  const row = w * channels;
  for (let y = 1; y < h - 1; y += 2) {
    for (let x = 1; x < w - 1; x += 2) {
      const i = (y * w + x) * channels + 1;
      const l = 4 * data[i] - data[i - channels] - data[i + channels] - data[i - row] - data[i + row];
      sum += l;
      sum2 += l * l;
      n += 1;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

export function trackingTuning(night) {
  return night
    ? { minHits: 4, smoothing: 0.45, maxAgeMs: 2200, hysteresisScale: 1.5, threshScale: 0.85 }
    : { minHits: 3, smoothing: 0.6, maxAgeMs: 1500, hysteresisScale: 1, threshScale: 1 };
}

/** Mean green-channel value of an RGB(A) pixel buffer, sparsely sampled. */
export function meanLuma(data, channels) {
  const pixels = Math.floor(data.length / channels);
  const step = Math.max(1, Math.floor(pixels / 256));
  let sum = 0;
  let n = 0;
  for (let i = 0; i < pixels; i += step) {
    sum += data[i * channels + 1]; // green ~ luma
    n += 1;
  }
  return n ? sum / n : 128;
}
