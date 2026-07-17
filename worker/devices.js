/**
 * Capture-device helpers, importable by the server MAIN thread — this module
 * must stay free of onnxruntime imports (the heavy runtime loads only inside
 * the engine worker thread).
 */
import { spawnSync } from 'node:child_process';

/** Null when the engine can run here, else a human-readable reason. */
export function checkRequirements() {
  const ff = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (ff.error) return 'ffmpeg not found — install it (macOS: brew install ffmpeg)';
  return null;
}

/** Video capture devices as the server sees them: [{index, name}]. */
export function listDevices() {
  const res = spawnSync('ffmpeg', ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''], {
    encoding: 'utf8',
  });
  const devices = [];
  let inVideo = false;
  for (const line of (res.stderr ?? '').split('\n')) {
    if (line.includes('AVFoundation video devices')) {
      inVideo = true;
      continue;
    }
    if (line.includes('AVFoundation audio devices')) break;
    const m = inVideo ? line.match(/\[(\d+)\]\s+(.+)$/) : null;
    if (m) devices.push({ index: Number(m[1]), name: m[2].trim() });
  }
  return devices;
}
