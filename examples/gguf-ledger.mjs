import { GGML_TYPE, closeGguf, readGguf, sampleTensor } from "../kernel/gguf.js";

const path = process.argv[2];
const sample = Number(process.argv[3] || 4);
if (!path) {
  console.error("usage: node examples/gguf-ledger.mjs <file.gguf> [blocks-per-tensor]");
  process.exit(1);
}

const file = await readGguf(path);
const arch = file.metadata["general.architecture"] || "";
const name = file.metadata["general.name"] || "";
const counts = new Map();
let bytes = 0;
for (const tensor of file.tensors) {
  const info = counts.get(tensor.typeName) || { tensors: 0, blocks: 0 };
  const count = tensor.dims.reduce((a, b) => a * b, 1);
  const spec = GGML_TYPE[tensor.type];
  info.tensors += 1;
  info.weights = (info.weights || 0) + count;
  if (spec?.block) info.blocks += count / spec.block;
  counts.set(tensor.typeName, info);
  bytes += count;
}
console.log(`file ${path}`);
console.log(`version ${file.version}  alignment ${file.alignment}  data ${file.dataStart}`);
console.log(`architecture ${arch}  name ${name}  tensors ${file.tensors.length}`);
console.log("types");
for (const [type, info] of [...counts.entries()].sort((a, b) => b[1].weights - a[1].weights)) {
  console.log(`  ${type}  tensors ${info.tensors}  weights ${info.weights}  blocks ${info.blocks || "-"}`);
}
console.log(`weights ${bytes}`);

const rows = [];
for (const tensor of file.tensors) {
  if (![6, 8, 12, 14].includes(tensor.type)) continue;
  rows.push(await sampleTensor(file, tensor, sample));
}
await closeGguf(file);

const scored = rows.filter((row) => row.sampled);
scored.sort((a, b) => b.maxLedgerError - a.maxLedgerError);
console.log(`sampled ${scored.length} tensors, ${sample} blocks each`);
console.log("tensor | type | blocks | phi scales | raw scales | max weight error | mean block max | scale error");
for (const row of scored) {
  console.log([
    row.name,
    row.typeName,
    row.blocks,
    row.phiBlocks,
    row.rawBlocks,
    row.maxLedgerError.toExponential(3),
    row.meanBlockMaxError.toExponential(3),
    row.maxPhiScaleError.toExponential(3)
  ].join(" | "));
}
const byType = new Map();
for (const row of scored) {
  const bucket = byType.get(row.typeName) || { phi: 0, raw: 0, max: 0, sum: 0, n: 0, worst: row };
  bucket.phi += row.phiBlocks;
  bucket.raw += row.rawBlocks;
  bucket.sum += row.meanBlockMaxError;
  bucket.n += 1;
  if (row.maxLedgerError > bucket.max) {
    bucket.max = row.maxLedgerError;
    bucket.worst = row;
  }
  byType.set(row.typeName, bucket);
}
console.log("type summary");
for (const [type, bucket] of byType) {
  console.log(`  ${type}  phi ${bucket.phi}  raw ${bucket.raw}  worst ${bucket.max.toExponential(3)} (${bucket.worst.name})  mean-of-means ${ (bucket.sum / bucket.n).toExponential(3) }`);
}
