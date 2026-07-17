import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sideOfLine,
  signedDistance,
  positiveNormal,
  intersectionParams,
  pointInPolygon,
  iou,
  boxCenter,
} from '../public/js/geometry.js';

const A = { x: 0, y: 100 };
const B = { x: 200, y: 100 }; // horizontal line, positive side = below (y > 100)

test('sideOfLine sign convention', () => {
  assert.ok(sideOfLine({ x: 50, y: 150 }, A, B) > 0, 'below the line is positive');
  assert.ok(sideOfLine({ x: 50, y: 50 }, A, B) < 0, 'above the line is negative');
  assert.equal(sideOfLine({ x: 50, y: 100 }, A, B), 0, 'on the line is zero');
});

test('signedDistance is perpendicular distance with sign', () => {
  assert.equal(signedDistance({ x: 50, y: 130 }, A, B), 30);
  assert.equal(signedDistance({ x: 50, y: 70 }, A, B), -30);
});

test('positiveNormal points toward the positive side', () => {
  const n = positiveNormal(A, B);
  assert.equal(Math.abs(n.x), 0);
  assert.equal(n.y, 1);
  const p = { x: 100 + n.x * 10, y: 100 + n.y * 10 };
  assert.ok(sideOfLine(p, A, B) > 0);
});

test('intersectionParams finds the crossing point', () => {
  const hit = intersectionParams({ x: 100, y: 50 }, { x: 100, y: 150 }, A, B);
  assert.equal(hit.t, 0.5); // halfway along the movement
  assert.equal(hit.s, 0.5); // halfway along the line
});

test('intersectionParams reports out-of-extent crossings via s', () => {
  const hit = intersectionParams({ x: 300, y: 50 }, { x: 300, y: 150 }, A, B);
  assert.equal(hit.s, 1.5); // beyond endpoint B
});

test('intersectionParams returns null for parallel segments', () => {
  assert.equal(intersectionParams({ x: 0, y: 0 }, { x: 10, y: 0 }, A, B), null);
});

test('pointInPolygon', () => {
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  assert.ok(pointInPolygon({ x: 5, y: 5 }, square));
  assert.ok(!pointInPolygon({ x: 15, y: 5 }, square));
  assert.ok(!pointInPolygon({ x: 5, y: 5 }, square.slice(0, 2)), 'degenerate polygon');
});

test('iou', () => {
  assert.equal(iou([0, 0, 10, 10], [0, 0, 10, 10]), 1);
  assert.equal(iou([0, 0, 10, 10], [20, 20, 10, 10]), 0);
  const half = iou([0, 0, 10, 10], [5, 0, 10, 10]); // overlap 50, union 150
  assert.ok(Math.abs(half - 1 / 3) < 1e-9);
});

test('boxCenter', () => {
  assert.deepEqual(boxCenter([10, 20, 30, 40]), { x: 25, y: 40 });
});
