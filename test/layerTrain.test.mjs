import assert from "node:assert/strict";
import test from "node:test";
import { encodeScale } from "../kernel/phi75.js";

import {
  blocksFromWeights,
  fitRowGains,
  makeInputs,
  outputLoss,
  reconstructBlocks,
  reconstructWithRowGains,
  trainLedgerMatrix
} from "../kernel/layerTrain.js";

test("a blank ledger learns the file matrix and then holds", () => {
  const file = Float32Array.from([0.5, 0, 0, 0, 0, -0.5, 0, 0]);
  const blocks = [
    { trits: new Int8Array(4), votes: new Int16Array(4), scale: encodeScale(0.5), outlier: new Uint8Array(4), exact: new Float32Array(4) },
    { trits: new Int8Array(4), votes: new Int16Array(4), scale: encodeScale(0.5), outlier: new Uint8Array(4), exact: new Float32Array(4) }
  ];
  const train = makeInputs(6, 4, 3);
  const start = outputLoss(file, reconstructBlocks(blocks, 4), train, 2, 4).mse;
  const report = trainLedgerMatrix(blocks, file, 2, 4, { blockSize: 4, steps: 20, trip: 1, lr: 0.2, train, seed: 3 });
  assert.ok(report.after.mse < start);
  assert.ok(report.kept >= 1);
  assert.equal(blocks[0].trits[0], 1);
  assert.equal(blocks[1].trits[1], -1);
  const again = trainLedgerMatrix(blocks, file, 2, 4, { blockSize: 4, steps: 4, trip: 1, lr: 0.2, train, seed: 3 });
  assert.ok(again.after.mse <= report.after.mse + 1e-12);
});

test("a row gain restores a row that was scaled down", () => {
  const file = Float32Array.from([1, 0, 0, 0]);
  const blocks = [{
    trits: Int8Array.from([1, 0, 0, 0]),
    scale: encodeScale(0.5),
    outlier: new Uint8Array(4),
    exact: new Float32Array(4)
  }];
  const gains = fitRowGains(file, blocks, 1, 4, 4);
  const led = reconstructWithRowGains(blocks, 4, gains, 4);
  assert.ok(Math.abs(led[0] - 1) < 1e-6);
  const inputs = makeInputs(4, 4, 1);
  const before = outputLoss(file, reconstructBlocks(blocks, 4), inputs, 1, 4).mse;
  const after = outputLoss(file, led, inputs, 1, 4).mse;
  assert.ok(after < before);
});

test("outlier floats stay on the file value", () => {
  const file = Float32Array.from({ length: 8 }, (_, i) => (i === 3 ? 0.9 : 0.02));
  const blocks = blocksFromWeights(file, 4, 0.05);
  assert.equal(blocks[0].outlier[3], 1);
  const exact = blocks[0].exact[3];
  trainLedgerMatrix(blocks, file, 2, 4, { blockSize: 4, steps: 6, seed: 9 });
  assert.equal(blocks[0].outlier[3], 1);
  assert.equal(blocks[0].exact[3], exact);
  const led = reconstructBlocks(blocks, 4);
  assert.equal(led[3], exact);
});
