import assert from "node:assert/strict";
import test from "node:test";
import { createMind, think } from "../kernel/brainMind.js";
import { computeRadius, WolframRule30 } from "../kernel/orbital.js";
import { createInitialTernaryCortex } from "../kernel/sovereignEcosystem.js";

test("Think rewrites a wrong operator and then replays it", () => {
  let mind = createMind();
  const first = think(mind, "14 - 9");
  assert.equal(first.verdict, "PASS");
  assert.equal(first.got, 5);
  assert.equal(first.mind.opcodes["-"], "SUB");
  mind = first.mind;

  const second = think(mind, "100 - 37");
  assert.equal(second.verdict, "PASS");
  assert.equal(second.got, 63);
  assert.ok(second.steps.some((step) => step.phase === "replay"));

  const product = think(second.mind, "6 * 7");
  assert.equal(product.verdict, "PASS");
  assert.equal(product.got, 42);
  assert.equal(product.mind.opcodes["*"], "MUL");

  const ratio = think(product.mind, "8 / 2");
  assert.equal(ratio.verdict, "PASS");
  assert.equal(ratio.got, 4);
  assert.equal(ratio.mind.opcodes["/"], "DIV");
});

test("a missing fact fails and a bare sentence stays unverified", () => {
  let mind = createMind();
  const stored = think(mind, "remember studio = fraymus");
  assert.equal(stored.verdict, "PASS");
  const read = think(stored.mind, "recall studio");
  assert.equal(read.verdict, "PASS");
  assert.equal(read.got, "fraymus");
  const missing = think(read.mind, "recall nowhere");
  assert.equal(missing.verdict, "FAIL");
  const prose = think(missing.mind, "what is the capital");
  assert.equal(prose.verdict, "UNVERIFIED");
});

test("two binds retire overwrite-zero when the second name would collide", () => {
  let mind = createMind();
  const fire = think(mind, "bind fire 7");
  assert.equal(fire.verdict, "PASS");
  const steam = think(fire.mind, "bind steam 4");
  assert.equal(steam.verdict, "PASS");
  assert.equal(steam.mind.placement, "next-free");
  assert.equal(steam.mind.binds.length, 2);
});

test("orbital radius and the ternary cortex both run from this package", () => {
  assert.ok(computeRadius(1) < computeRadius(0));
  const rule = new WolframRule30(Uint8Array.from([1, 2, 3]));
  const first = rule.rowString();
  rule.nextBits(1);
  assert.notEqual(rule.rowString(), first);
  const cortex = createInitialTernaryCortex("fraymus-brain");
  assert.equal(cortex.multiplyOps, 0);
  assert.equal(cortex.crumbRoundTripOk, true);
  assert.equal(cortex.trits.length, 256);
});
