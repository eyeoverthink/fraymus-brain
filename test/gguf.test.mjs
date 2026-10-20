import assert from "node:assert/strict";
import test from "node:test";
import { f16ToF32, f32ToF16 } from "../kernel/phi75.js";
import { unpackQ4_K, unpackQ5_0, unpackQ6_K } from "../kernel/gguf.js";

test("Q5_0 decodes the low and high 5-bit codes", () => {
  const bytes = Buffer.alloc(22);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, f32ToF16(0.25), true);
  bytes[6] = 0x10;
  const weights = unpackQ5_0(bytes).weights;
  assert.ok(Math.abs(weights[0] - (0 - 16) * 0.25) < 1e-6);
  assert.ok(Math.abs(weights[16] - (1 - 16) * 0.25) < 1e-6);
});

test("Q6_K decodes the first 6-bit code with its int8 scale", () => {
  const bytes = Buffer.alloc(210);
  const view = new DataView(bytes.buffer);
  view.setUint16(208, f32ToF16(0.5), true);
  view.setInt8(192, 2);
  bytes[0] = 0x04;
  const weights = unpackQ6_K(bytes).weights;
  const q1 = (0x04 | 0) - 32;
  assert.ok(Math.abs(weights[0] - 0.5 * 2 * q1) < 1e-5);
});

test("Q4_K keeps the super-block scale on the first nibble", () => {
  const bytes = Buffer.alloc(144);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, f32ToF16(0.01), true);
  view.setUint16(2, f32ToF16(0.001), true);
  bytes[4] = 2;
  bytes[8] = 3;
  bytes[16] = 0x05;
  const decoded = unpackQ4_K(bytes);
  const d = f16ToF32(f32ToF16(0.01));
  const min = f16ToF32(f32ToF16(0.001));
  const expect = d * 2 * 5 - min * 3;
  assert.ok(Math.abs(decoded.weights[0] - expect) < 1e-5);
});
