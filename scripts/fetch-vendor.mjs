#!/usr/bin/env node
/**
 * Downloads the ML runtimes and detection models into public/vendor/ so the
 * app is fully self-hosted (and works offline as a PWA). Without these files
 * the frontend falls back to CDN for the TF.js/COCO-SSD path; the YOLOX
 * models are self-hosted only.
 *
 * Usage: bun run setup            # TF.js + COCO-SSD + ONNX runtime + YOLOX nano/tiny
 *        bun run setup --model s  # additionally fetch YOLOX-s (36 MB, most accurate)
 *        add --force to re-download
 */
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const VENDOR = join(dirname(dirname(fileURLToPath(import.meta.url))), 'public', 'vendor');
const MODEL_BASE = 'https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2';
const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist';
const YOLOX_BASE = 'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0';
const FILES = [
  ['https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js', 'tf.min.js'],
  ['https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js', 'coco-ssd.min.js'],
  // ONNX Runtime Web (WebGPU + WASM in one bundle) for the YOLOX backends
  [`${ORT_BASE}/ort.min.js`, 'ort/ort.min.js'],
  [`${ORT_BASE}/ort-wasm-simd-threaded.jsep.wasm`, 'ort/ort-wasm-simd-threaded.jsep.wasm'],
  [`${ORT_BASE}/ort-wasm-simd-threaded.jsep.mjs`, 'ort/ort-wasm-simd-threaded.jsep.mjs'],
  [`${ORT_BASE}/ort-wasm-simd-threaded.wasm`, 'ort/ort-wasm-simd-threaded.wasm'],
  [`${ORT_BASE}/ort-wasm-simd-threaded.mjs`, 'ort/ort-wasm-simd-threaded.mjs'],
  // YOLOX detection models (Apache-2.0, official release ONNX)
  [`${YOLOX_BASE}/yolox_nano.onnx`, 'models/yolox_nano.onnx'],
  [`${YOLOX_BASE}/yolox_tiny.onnx`, 'models/yolox_tiny.onnx'],
];
if (process.argv.includes('--model') && process.argv[process.argv.indexOf('--model') + 1] === 's') {
  FILES.push([`${YOLOX_BASE}/yolox_s.onnx`, 'models/yolox_s.onnx']);
}
const force = process.argv.includes('--force');

async function exists(path) {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

async function download(url, relPath) {
  const dest = join(VENDOR, relPath);
  if (!force && (await exists(dest))) {
    console.log(`skip  ${relPath} (already present)`);
    return;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  console.log(`fetch ${relPath} (${(buf.length / 1024).toFixed(0)} KiB)`);
}

for (const [url, rel] of FILES) await download(url, rel);

await download(`${MODEL_BASE}/model.json`, 'model/model.json');
const manifest = JSON.parse(
  await (await fetch(`${MODEL_BASE}/model.json`)).text()
);
const shardPaths = (manifest.weightsManifest ?? []).flatMap((g) => g.paths);
for (const shard of shardPaths) {
  await download(`${MODEL_BASE}/${shard}`, join('model', shard));
}
console.log(`done: runtime + model (${shardPaths.length} weight shards) in public/vendor/`);

// --- native capture helper (macOS) ---
// ffmpeg's avfoundation input reaches only a camera's uncompressed formats
// (USB-2 webcams: ~5 fps at 1080p). The Swift helper uses AVCaptureSession,
// which selects the camera's MJPEG 30 fps modes like browsers do. Optional:
// without it the engine falls back to ffmpeg's (slow) camera path.
if (process.platform === 'darwin') {
  const { execFileSync } = await import('node:child_process');
  const repo = dirname(dirname(fileURLToPath(import.meta.url)));
  const src = join(repo, 'worker', 'capture.swift');
  const bin = join(repo, 'worker', '.bin', 'cc-capture');
  const mtime = async (p) => (await stat(p).catch(() => null))?.mtimeMs ?? 0;
  if ((await mtime(bin)) > (await mtime(src))) {
    console.log('skip  worker/.bin/cc-capture (up to date)');
  } else {
    try {
      execFileSync('xcrun', ['--find', 'swiftc'], { stdio: 'ignore' });
      await mkdir(join(repo, 'worker', '.bin'), { recursive: true });
      execFileSync('xcrun', ['--sdk', 'macosx', 'swiftc', '-O', src, '-o', bin], {
        stdio: 'inherit',
      });
      console.log('built worker/.bin/cc-capture (30 fps camera capture)');
    } catch {
      console.log('note: swiftc unavailable — camera capture will use ffmpeg (slower fps)');
    }
  }
}
