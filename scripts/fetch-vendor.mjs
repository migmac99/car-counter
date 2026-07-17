#!/usr/bin/env node
/**
 * Downloads the ML runtime and detection model into public/vendor/ so the app
 * is fully self-hosted (and works offline as a PWA). Without these files the
 * frontend transparently falls back to loading them from CDN/Google storage.
 *
 * Usage: npm run setup   (add --force to re-download)
 */
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const VENDOR = join(dirname(dirname(fileURLToPath(import.meta.url))), 'public', 'vendor');
const MODEL_BASE = 'https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2';
const FILES = [
  ['https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js', 'tf.min.js'],
  ['https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js', 'coco-ssd.min.js'],
];
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
