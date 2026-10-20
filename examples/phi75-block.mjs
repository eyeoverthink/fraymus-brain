import { ledgerFromFloats, packQ8_0, unpackQ8_0, createPhi75Neuron, lossPhi75, trainPhi75 } from "../index.js";

const source = Float32Array.from({ length: 32 }, (_, i) => Math.sin(i / 3) * 0.4);
const file = unpackQ8_0(packQ8_0(source));
const ledger = ledgerFromFloats(file.weights);
console.log("Q8_0 file scale", file.scale);
console.log("ledger form", ledger.scale.form, "e", ledger.scale.e, "m", ledger.scale.m);
console.log("bytes", `${ledger.fp32Bytes} fp32 -> ${ledger.ledgerBytes} ledger`);
console.log("phi scale error", ledger.phiScaleError);
console.log("max error vs file truth", ledger.maxLedgerError);

const batch = [
  { x: [1, 0], y: 0.5 },
  { x: [0, 1], y: -0.5 },
  { x: [1, 1], y: 0 },
  { x: [1, -1], y: 1 }
];
const neuron = createPhi75Neuron(2, 0.2);
console.log("train loss", lossPhi75(neuron, batch));
for (let step = 0; step < 12; step += 1) {
  const report = trainPhi75(neuron, batch);
  console.log(step, report.kept ? "kept" : "held", report.after.toFixed(6), report.form, report.trits.join(","));
}
