// GGUF reader for the weight plane.
// Walks the header, then reads Q8_0, Q5_0, Q4_K, and Q6_K blocks as the
// floats those blocks already decode to. The ledger in phi75.js is applied
// to those floats. Layouts match ggml-quants.c.

import { open } from "node:fs/promises";
import { f16ToF32, ledgerFromFloats, unpackQ8_0 } from "./phi75.js";

const GGUF_MAGIC = 0x46554747;
const VALUE = {
  UINT8: 0,
  INT8: 1,
  UINT16: 2,
  INT16: 3,
  UINT32: 4,
  INT32: 5,
  FLOAT32: 6,
  BOOL: 7,
  STRING: 8,
  ARRAY: 9,
  UINT64: 10,
  INT64: 11,
  FLOAT64: 12
};

export const GGML_TYPE = {
  0: { name: "F32", block: 1, bytes: 4 },
  1: { name: "F16", block: 1, bytes: 2 },
  2: { name: "Q4_0", block: 32, bytes: 18 },
  3: { name: "Q4_1", block: 32, bytes: 20 },
  6: { name: "Q5_0", block: 32, bytes: 22 },
  7: { name: "Q5_1", block: 32, bytes: 24 },
  8: { name: "Q8_0", block: 32, bytes: 34 },
  9: { name: "Q8_1", block: 32, bytes: 36 },
  10: { name: "Q2_K", block: 256, bytes: 84 },
  11: { name: "Q3_K", block: 256, bytes: 110 },
  12: { name: "Q4_K", block: 256, bytes: 144 },
  13: { name: "Q5_K", block: 256, bytes: 176 },
  14: { name: "Q6_K", block: 256, bytes: 210 },
  15: { name: "Q8_K", block: 256, bytes: 292 },
  30: { name: "BF16", block: 1, bytes: 2 }
};

const Q4_K_BYTES = 144;
const Q4_K_COUNT = 256;
const Q5_0_BYTES = 22;
const Q6_K_BYTES = 210;
const Q6_K_COUNT = 256;

class Cursor {
  constructor(handle) {
    this.handle = handle;
    this.pos = 0;
    this.buf = Buffer.alloc(0);
    this.base = 0;
  }

  async pull(need) {
    while (this.buf.length - (this.pos - this.base) < need) {
      const chunk = Buffer.alloc(1024 * 1024);
      const { bytesRead } = await this.handle.read(chunk, 0, chunk.length, this.base + this.buf.length);
      if (!bytesRead) throw new Error("GGUF ended early");
      this.buf = Buffer.concat([this.buf, chunk.subarray(0, bytesRead)]);
    }
  }

  async take(n) {
    await this.pull(n);
    const start = this.pos - this.base;
    const out = this.buf.subarray(start, start + n);
    this.pos += n;
    if (start > 8 * 1024 * 1024) {
      this.buf = this.buf.subarray(start + n);
      this.base = this.pos;
    }
    return out;
  }

  async u8() { return (await this.take(1))[0]; }
  async u16() { return (await this.take(2)).readUInt16LE(0); }
  async u32() { return (await this.take(4)).readUInt32LE(0); }
  async i32() { return (await this.take(4)).readInt32LE(0); }
  async f32() { return (await this.take(4)).readFloatLE(0); }
  async f64() { return (await this.take(8)).readDoubleLE(0); }
  async u64() {
    const raw = (await this.take(8)).readBigUInt64LE(0);
    if (raw > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("GGUF integer does not fit a JS number");
    return Number(raw);
  }
  async i64() {
    const raw = (await this.take(8)).readBigInt64LE(0);
    if (raw > BigInt(Number.MAX_SAFE_INTEGER) || raw < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new Error("GGUF integer does not fit a JS number");
    }
    return Number(raw);
  }
  async str() {
    const n = await this.u64();
    return (await this.take(n)).toString("utf8");
  }
}

async function skipValue(cur, type) {
  switch (type) {
    case VALUE.UINT8:
    case VALUE.INT8:
    case VALUE.BOOL:
      await cur.take(1);
      return;
    case VALUE.UINT16:
    case VALUE.INT16:
      await cur.take(2);
      return;
    case VALUE.UINT32:
    case VALUE.INT32:
    case VALUE.FLOAT32:
      await cur.take(4);
      return;
    case VALUE.UINT64:
    case VALUE.INT64:
    case VALUE.FLOAT64:
      await cur.take(8);
      return;
    case VALUE.STRING:
      await cur.str();
      return;
    case VALUE.ARRAY: {
      const inner = await cur.u32();
      const count = await cur.u64();
      for (let i = 0; i < count; i += 1) await skipValue(cur, inner);
      return;
    }
    default:
      throw new Error(`Unknown GGUF value type ${type}`);
  }
}

async function readValue(cur, type) {
  switch (type) {
    case VALUE.UINT8: return cur.u8();
    case VALUE.INT8: return (await cur.u8()) << 24 >> 24;
    case VALUE.UINT16: return cur.u16();
    case VALUE.INT16: return (await cur.u16()) << 16 >> 16;
    case VALUE.UINT32: return cur.u32();
    case VALUE.INT32: return cur.i32();
    case VALUE.FLOAT32: return cur.f32();
    case VALUE.BOOL: return (await cur.u8()) !== 0;
    case VALUE.STRING: return cur.str();
    case VALUE.UINT64: return cur.u64();
    case VALUE.INT64: return cur.i64();
    case VALUE.FLOAT64: return cur.f64();
    case VALUE.ARRAY: {
      const inner = await cur.u32();
      const count = await cur.u64();
      const values = [];
      for (let i = 0; i < count; i += 1) values.push(await readValue(cur, inner));
      return values;
    }
    default:
      throw new Error(`Unknown GGUF value type ${type}`);
  }
}

function align(offset, alignment) {
  const mask = alignment - 1;
  return (offset + mask) & ~mask;
}

export function ggmlType(code) {
  return GGML_TYPE[code] || { name: `type-${code}`, block: 0, bytes: 0 };
}

export function tensorBytes(tensor) {
  const info = ggmlType(tensor.type);
  if (!info.block) return 0;
  const count = tensor.dims.reduce((a, b) => a * b, 1);
  return (count / info.block) * info.bytes;
}

function scaleMinK4(j, scales) {
  if (j < 4) return [scales[j] & 63, scales[j + 4] & 63];
  return [
    (scales[j + 4] & 0x0f) | ((scales[j - 4] >> 6) << 4),
    (scales[j + 4] >> 4) | ((scales[j] >> 6) << 4)
  ];
}

export function unpackQ4_K(bytes) {
  if (bytes.length < Q4_K_BYTES) throw new Error("Q4_K block is 144 bytes");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const d = f16ToF32(view.getUint16(0, true));
  const dmin = f16ToF32(view.getUint16(2, true));
  const scales = bytes.subarray(4, 16);
  const qs = bytes.subarray(16, 144);
  const weights = new Float32Array(Q4_K_COUNT);
  let qAt = 0;
  let out = 0;
  let is = 0;
  for (let group = 0; group < 4; group += 1) {
    const [sc0, m0] = scaleMinK4(is, scales);
    const [sc1, m1] = scaleMinK4(is + 1, scales);
    const d1 = d * sc0;
    const min1 = dmin * m0;
    const d2 = d * sc1;
    const min2 = dmin * m1;
    for (let l = 0; l < 32; l += 1) weights[out++] = d1 * (qs[qAt + l] & 0x0f) - min1;
    for (let l = 0; l < 32; l += 1) weights[out++] = d2 * (qs[qAt + l] >> 4) - min2;
    qAt += 32;
    is += 2;
  }
  return { scale: d, min: dmin, weights };
}

export function unpackQ5_0(bytes) {
  if (bytes.length < Q5_0_BYTES) throw new Error("Q5_0 block is 22 bytes");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const d = f16ToF32(view.getUint16(0, true));
  const qh = view.getUint32(2, true);
  const weights = new Float32Array(32);
  for (let j = 0; j < 16; j += 1) {
    const qs = bytes[6 + j];
    const xh0 = ((qh >>> j) << 4) & 0x10;
    const xh1 = (qh >>> (j + 12)) & 0x10;
    const x0 = ((qs & 0x0f) | xh0) - 16;
    const x1 = ((qs >> 4) | xh1) - 16;
    weights[j] = x0 * d;
    weights[j + 16] = x1 * d;
  }
  return { scale: d, weights };
}

export function unpackQ6_K(bytes) {
  if (bytes.length < Q6_K_BYTES) throw new Error("Q6_K block is 210 bytes");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const d = f16ToF32(view.getUint16(208, true));
  const weights = new Float32Array(Q6_K_COUNT);
  for (let half = 0; half < 2; half += 1) {
    const base = half * 128;
    const ql = 64 * half;
    const qh = 128 + 32 * half;
    const sc = 192 + 8 * half;
    for (let l = 0; l < 32; l += 1) {
      const is = Math.floor(l / 16);
      const hi = bytes[qh + l];
      const q1 = ((bytes[ql + l] & 0x0f) | (((hi >> 0) & 3) << 4)) - 32;
      const q2 = ((bytes[ql + 32 + l] & 0x0f) | (((hi >> 2) & 3) << 4)) - 32;
      const q3 = ((bytes[ql + l] >> 4) | (((hi >> 4) & 3) << 4)) - 32;
      const q4 = ((bytes[ql + 32 + l] >> 4) | (((hi >> 6) & 3) << 4)) - 32;
      const s0 = view.getInt8(sc + is);
      const s2 = view.getInt8(sc + is + 2);
      const s4 = view.getInt8(sc + is + 4);
      const s6 = view.getInt8(sc + is + 6);
      weights[base + l] = d * s0 * q1;
      weights[base + 32 + l] = d * s2 * q2;
      weights[base + 64 + l] = d * s4 * q3;
      weights[base + 96 + l] = d * s6 * q4;
    }
  }
  return { scale: d, weights };
}

const UNPACK = {
  6: unpackQ5_0,
  8: unpackQ8_0,
  12: unpackQ4_K,
  14: unpackQ6_K
};

export async function readGguf(path, options = {}) {
  const keepMeta = options.metadata === true;
  const handle = await open(path, "r");
  try {
    const cur = new Cursor(handle);
    const magic = await cur.u32();
    if (magic !== GGUF_MAGIC) throw new Error("Not a GGUF file");
    const version = await cur.u32();
    if (version < 2) throw new Error(`GGUF version ${version} is too old`);
    const tensorCount = await cur.u64();
    const kvCount = await cur.u64();
    const metadata = {};
    for (let i = 0; i < kvCount; i += 1) {
      const key = await cur.str();
      const type = await cur.u32();
      if (keepMeta || key === "general.alignment" || key === "general.architecture" || key === "general.name" || key === "general.file_type") {
        metadata[key] = await readValue(cur, type);
      } else {
        await skipValue(cur, type);
      }
    }
    const tensors = [];
    for (let i = 0; i < tensorCount; i += 1) {
      const name = await cur.str();
      const nDims = await cur.u32();
      const dims = [];
      for (let d = 0; d < nDims; d += 1) dims.push(await cur.u64());
      const type = await cur.u32();
      const offset = await cur.u64();
      tensors.push({ name, dims, type, typeName: ggmlType(type).name, offset });
    }
    const alignment = Number(metadata["general.alignment"] || 32);
    const dataStart = align(cur.pos, alignment);
    return { version, alignment, dataStart, metadata, tensors, handle, path };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readAt(handle, position, length) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buf, 0, length, position);
  if (bytesRead !== length) throw new Error("Short read in tensor data");
  return buf;
}

export async function sampleTensor(file, tensor, sampleBlocks = 8) {
  const info = ggmlType(tensor.type);
  if (!info.block) return { ...tensor, blocks: 0, sampled: 0, note: "no block size" };
  const count = tensor.dims.reduce((a, b) => a * b, 1);
  const blocks = count / info.block;
  const take = Math.min(sampleBlocks, blocks);
  let phiBlocks = 0;
  let rawBlocks = 0;
  let maxLedgerError = 0;
  let maxPhiScaleError = 0;
  let sumLedgerError = 0;
  const unpack = UNPACK[tensor.type];
  if (!unpack) {
    return {
      name: tensor.name,
      typeName: tensor.typeName,
      dims: tensor.dims,
      blocks,
      bytes: blocks * info.bytes,
      sampled: 0,
      note: "dequant not in this reader yet"
    };
  }
  const blockBytes = info.bytes;
  const stride = Math.max(1, Math.floor(blocks / take));
  for (let i = 0; i < take; i += 1) {
    const index = Math.min(blocks - 1, i * stride);
    const raw = await readAt(file.handle, file.dataStart + tensor.offset + index * blockBytes, blockBytes);
    const decoded = unpack(raw);
    const ledger = ledgerFromFloats(decoded.weights);
    if (ledger.scale.fallback) rawBlocks += 1;
    else phiBlocks += 1;
    maxLedgerError = Math.max(maxLedgerError, ledger.maxLedgerError);
    maxPhiScaleError = Math.max(maxPhiScaleError, ledger.phiScaleError);
    sumLedgerError += ledger.maxLedgerError;
  }
  return {
    name: tensor.name,
    typeName: tensor.typeName,
    dims: tensor.dims,
    blocks,
    bytes: blocks * info.bytes,
    sampled: take,
    phiBlocks,
    rawBlocks,
    maxLedgerError,
    meanBlockMaxError: sumLedgerError / take,
    maxPhiScaleError
  };
}

export async function closeGguf(file) {
  await file.handle.close();
}
