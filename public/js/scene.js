/**
 * Scene-aware tracking tuning, shared by the browser pipeline and the
 * server engine. At night vehicles are essentially headlight blobs: the
 * detector scores real cars lower (so the association threshold relaxes),
 * while flickery lights demand MORE evidence before a track is believed
 * (higher minHits), heavier centroid smoothing, longer track memory and a
 * wider crossing dead-band.
 */

// Mean luma (0-255) with hysteresis so dusk doesn't flap the mode.
export const NIGHT_ENTER_LUMA = 65;
export const NIGHT_EXIT_LUMA = 90;

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
