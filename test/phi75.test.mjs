import assert from "node:assert/strict";
import test from "node:test";
import {
  PHI,
  PHI_75,
  phiPow,
  packQ8_0,
  unpackQ8_0,
  encodeScale,
  decodeScale,
  ledgerFromFloats,
  createPhi75Neuron,
  lossPhi75,
  trainPhi75,
  f32ToF16,
  f16ToF32
} from "../kernel/phi75.js";

test("φ powers follow the Fibonacci recurrence", () => {
  for (let n = 2; n <= 40; n += 1) {
    const got = phiPow(n);
    const sum = phiPow(n - 1) + phiPow(n - 2);
    assert.ok(Math.abs(got - sum) / got < 1e-9, `φ^${n}`);
  }
  assert.ok(Math.abs(phiPow(1) - PHI) < 1e-12);
  assert.ok(Math.abs(phiPow(75) - PHI_75) / PHI_75 < 1e-12);
});

test("a faithful scale decodes back, and a bad tolerance keeps the raw float", () => {
  const code = encodeScale(0.125);
  assert.equal(code.form, "phi");
  assert.equal(code.faithful, true);
  assert.ok(Math.abs(decodeScale(code) - 0.125) <= code.tolerance);

  const raw = encodeScale(1 / 3, 1e-12);
  assert.equal(raw.form, "raw-f32");
  assert.equal(decodeScale(raw), 1 / 3);
  assert.ok(raw.nearestError > raw.tolerance);
});

test("float16 round-trips a Q8 scale", () => {
  const half = f32ToF16(0.015625);
  const back = f16ToF32(half);
  assert.ok(Math.abs(back - 0.015625) < 1e-6);
});

test("a Q8_0 block decodes to the file weights, then the ledger reports both errors", () => {
  const source = Float32Array.from({ length: 32 }, (_, i) => Math.sin(i) * 0.5);
  const block = packQ8_0(source);
  assert.equal(block.length, 34);
  const file = unpackQ8_0(block);
  for (let i = 0; i < 32; i += 1) {
    const expected = file.scale * file.codes[i];
    assert.ok(Math.abs(file.weights[i] - expected) < 1e-6);
  }
  const ledger = ledgerFromFloats(file.weights);
  assert.equal(ledger.count, 32);
  assert.ok(ledger.ledgerBytes < ledger.fp32Bytes);
  assert.ok(ledger.phiScaleError <= (ledger.scale.tolerance ?? 1e-4));
  assert.ok(ledger.maxLedgerError >= 0);
  assert.ok(ledger.maxTernaryError > 0);
});

test("one neuron learns a ternary pattern and refuses a step that gets worse", () => {
  const batch = [
    { x: [1, 0], y: 0.5 },
    { x: [0, 1], y: -0.5 },
    { x: [1, 1], y: 0 },
    { x: [1, -1], y: 1 }
  ];
  const neuron = createPhi75Neuron(2, 0.2);
  const start = lossPhi75(neuron, batch);
  let last = null;
  for (let step = 0; step < 40; step += 1) last = trainPhi75(neuron, batch);
  const end = lossPhi75(neuron, batch);
  assert.ok(end < start * 0.25, `loss ${start} -> ${end}`);
  assert.deepEqual(Array.from(neuron.trits), [1, -1]);
  assert.equal(last.kept, false);
  assert.ok(end <= last.before + 1e-9);
});
