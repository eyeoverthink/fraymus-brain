import { writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { closeGguf, readGguf } from "../kernel/gguf.js";
import { unpackQ8_0 } from "../kernel/phi75.js";
import { blocksFromWeights, checkpointBlocks, makeInputs, trainLedgerMatrix } from "../kernel/layerTrain.js";

const path = process.argv[2];
const out = process.argv[3] || "checkpoints/qwen2.5-0.5b-blk0-attn-v.json";
if (!path) {
  console.error("usage: node examples/train-attn-v.mjs <model.gguf> [checkpoint.json]");
  process.exit(1);
}

const file = await readGguf(path);
const tensor = file.tensors.find((item) => item.name === "blk.0.attn_v.weight");
if (!tensor || tensor.type !== 8) throw new Error("blk.0.attn_v.weight is not a Q8_0 tensor in this file");
const cols = tensor.dims[0];
const rows = tensor.dims[1];
const count = rows * cols;
const blocksN = count / 32;
const raw = Buffer.alloc(blocksN * 34);
const { bytesRead } = await file.handle.read(raw, 0, raw.length, file.dataStart + tensor.offset);
if (bytesRead !== raw.length) throw new Error("Short read of attn_v");
await closeGguf(file);

const weights = new Float32Array(count);
for (let block = 0; block < blocksN; block += 1) {
  const decoded = unpackQ8_0(raw.subarray(block * 34, (block + 1) * 34));
  weights.set(decoded.weights, block * 32);
}

const budget = 0.05;
const blocks = blocksFromWeights(weights, 32, budget);
const outliers = blocks.reduce((sum, block) => sum + block.outlier.reduce((s, flag) => s + flag, 0), 0);
const report = trainLedgerMatrix(blocks, weights, rows, cols, {
  blockSize: 32,
  budget,
  steps: 8,
  trip: 2,
  lr: 0.02,
  seed: 75,
  train: makeInputs(32, cols, 75),
  heldOut: makeInputs(32, cols, 175)
});

const payload = {
  tensor: tensor.name,
  model: "Qwen2.5 0.5B Instruct",
  rows,
  cols,
  block: 32,
  budget,
  outliers,
  train: {
    mseBefore: report.before.mse,
    mseAfter: report.after.mse,
    relativeBefore: report.before.relative,
    relativeAfter: report.after.relative,
    heldOutRelativeBefore: report.heldOutBefore.relative,
    heldOutRelativeAfter: report.heldOutAfter.relative,
    kept: report.kept,
    steps: report.steps,
    maxInlierError: report.maxInlierError
  },
  blocks: checkpointBlocks(blocks)
};
await mkdir(out.slice(0, out.lastIndexOf("/")), { recursive: true });
await writeFile(out, JSON.stringify(payload));
console.log(JSON.stringify(payload.train, null, 2));
console.log("outliers", outliers, "checkpoint", out);
