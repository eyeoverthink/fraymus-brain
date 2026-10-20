// φ^75 weight ledger.
//
// A GGUF block already stores one scale plus short integer codes.
// This module keeps that idea and writes the scale as a short pair (e, m):
//
//   scale = m * φ^e / 1024
//
// φ^n = F_n * φ + F_{n-1}, so an integer power of φ is two Fibonacci numbers,
// and φ^n = φ^{n-1} + φ^{n-2}. The heavy matrix stays ternary {-1, 0, +1}.
// The matmul is adds and subtracts. φ does not make that matmul faster.
// It makes the scale shorter, and the pair is kept only when it decodes
// inside the caller's tolerance. Otherwise the raw float is stored.
// The numbers you get back are the numbers you put in, within that tolerance.
//
// Q8_0 matches llama.cpp: 2-byte float16 scale, then 32 int8 codes.
// Dequant is scale * code. That decoded float is the file truth.

export const PHI = (1 + Math.sqrt(5)) / 2;
export const PHI_75 = 4721424167835376.0;
export const MANTISSA_DEN = 1024;
export const Q8_0_COUNT = 32;
export const Q8_0_BYTES = 34;

const FIB_LIMIT = 78;

function fibPair(n) {
  const k = Math.abs(n);
  if (k > FIB_LIMIT) throw new Error(`φ^${n} is past the exact Fibonacci range used here`);
  let prev = 0;
  let curr = 1;
  for (let i = 1; i < k; i += 1) {
    const next = prev + curr;
    prev = curr;
    curr = next;
  }
  if (k === 0) return [0, 1];
  return [curr, prev];
}

export function phiPow(n) {
  const e = Math.trunc(n);
  if (e === 0) return 1;
  const [fibN, fibPrev] = fibPair(e);
  const mag = fibN * PHI + fibPrev;
  return e < 0 ? 1 / mag : mag;
}

export function f32ToF16(value) {
  const bits = new DataView(new ArrayBuffer(4));
  bits.setFloat32(0, value, true);
  const x = bits.getUint32(0, true);
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  const mant = x & 0x7fffff;
  if (exp === 255) return sign | (mant ? 0x7e00 : 0x7c00);
  const halfExp = exp - 127 + 15;
  if (halfExp >= 31) return sign | 0x7c00;
  if (halfExp <= 0) {
    if (halfExp < -10) return sign;
    const shifted = (mant | 0x800000) >> (1 - halfExp);
    return sign | ((shifted + 0x1000) >> 13);
  }
  const rounded = mant + 0x1000;
  if (rounded & 0x800000) return sign | ((halfExp + 1) << 10);
  return sign | (halfExp << 10) | (rounded >> 13);
}

export function f16ToF32(half) {
  const sign = (half & 0x8000) << 16;
  const exp = (half >>> 10) & 0x1f;
  const mant = half & 0x3ff;
  const bits = new DataView(new ArrayBuffer(4));
  let out = sign;
  if (exp === 0) {
    if (mant !== 0) {
      let e = -14;
      let m = mant;
      while ((m & 0x400) === 0) {
        m <<= 1;
        e -= 1;
      }
      m &= 0x3ff;
      out |= ((e + 127) << 23) | (m << 13);
    }
  } else if (exp === 31) {
    out |= 0x7f800000 | (mant << 13);
  } else {
    out |= ((exp - 15 + 127) << 23) | (mant << 13);
  }
  bits.setUint32(0, out >>> 0, true);
  return bits.getFloat32(0, true);
}

export function packQ8_0(floats) {
  if (floats.length !== Q8_0_COUNT) throw new Error("A Q8_0 block holds 32 weights");
  let max = 0;
  for (let i = 0; i < Q8_0_COUNT; i += 1) max = Math.max(max, Math.abs(floats[i]));
  const scale = max === 0 ? 0 : max / 127;
  const bytes = new Uint8Array(Q8_0_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, f32ToF16(scale), true);
  for (let i = 0; i < Q8_0_COUNT; i += 1) {
    const q = scale === 0 ? 0 : Math.max(-127, Math.min(127, Math.round(floats[i] / scale)));
    view.setInt8(2 + i, q);
  }
  return bytes;
}

export function unpackQ8_0(bytes) {
  if (bytes.length < Q8_0_BYTES) throw new Error("Q8_0 block is 34 bytes");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const scale = f16ToF32(view.getUint16(0, true));
  const weights = new Float32Array(Q8_0_COUNT);
  const codes = new Int8Array(Q8_0_COUNT);
  for (let i = 0; i < Q8_0_COUNT; i += 1) {
    codes[i] = view.getInt8(2 + i);
    weights[i] = scale * codes[i];
  }
  return { scale, codes, weights };
}

export function encodeScale(sigma, tolerance) {
  const value = Number(sigma);
  if (!Number.isFinite(value)) throw new Error("A scale has to be a finite number");
  if (value === 0) {
    return { form: "zero", e: 0, m: 0, sigmaHat: 0, error: 0, faithful: true, fallback: false };
  }
  const abs = Math.abs(value);
  const sign = value < 0 ? -1 : 1;
  const e0 = Math.round(Math.log(abs) / Math.log(PHI));
  let best = null;
  for (let de = -8; de <= 8; de += 1) {
    const e = e0 + de;
    if (Math.abs(e) > FIB_LIMIT) continue;
    const base = phiPow(e);
    let m = Math.round((abs * MANTISSA_DEN) / base);
    if (m < 1 || m > 65535) continue;
    const sigmaHat = sign * (m * base) / MANTISSA_DEN;
    const error = Math.abs(sigmaHat - value);
    if (!best || error < best.error) best = { e, m: sign * m, sigmaHat, error };
  }
  const tol = tolerance == null ? Math.max(abs * 1e-4, 1e-8) : tolerance;
  if (best && best.error <= tol) {
    return { form: "phi", ...best, faithful: true, fallback: false, tolerance: tol };
  }
  return {
    form: "raw-f32",
    e: best?.e ?? 0,
    m: best?.m ?? 0,
    sigmaHat: value,
    raw: value,
    error: 0,
    nearestError: best?.error ?? abs,
    faithful: true,
    fallback: true,
    tolerance: tol
  };
}

export function decodeScale(code) {
  if (!code) return 0;
  if (code.form === "raw-f32" || code.fallback) return code.raw;
  if (!code.m) return 0;
  const sign = code.m < 0 ? -1 : 1;
  return sign * (Math.abs(code.m) * phiPow(code.e)) / MANTISSA_DEN;
}

export function packCrumbs(trits) {
  const packed = new Uint8Array(Math.ceil(trits.length / 4));
  for (let i = 0; i < trits.length; i += 1) {
    const crumb = trits[i] < 0 ? 3 : trits[i] > 0 ? 1 : 0;
    packed[i >> 2] |= (crumb & 3) << ((i & 3) * 2);
  }
  return packed;
}

export function unpackCrumbs(packed, count) {
  const trits = new Int8Array(count);
  for (let i = 0; i < count; i += 1) {
    const crumb = (packed[i >> 2] >> ((i & 3) * 2)) & 3;
    trits[i] = crumb === 3 ? -1 : crumb === 1 ? 1 : 0;
  }
  return trits;
}

export function ledgerFromFloats(floats, options = {}) {
  const values = Float32Array.from(floats);
  const n = values.length;
  let absSum = 0;
  for (let i = 0; i < n; i += 1) absSum += Math.abs(values[i]);
  const gamma = n === 0 ? 0 : absSum / n;
  const trits = new Int8Array(n);
  const denom = gamma + 1e-12;
  for (let i = 0; i < n; i += 1) {
    const q = Math.round(values[i] / denom);
    trits[i] = q > 1 ? 1 : q < -1 ? -1 : q;
  }
  const scale = encodeScale(gamma, options.tolerance);
  const decodedScale = decodeScale(scale);
  const reconstructed = new Float32Array(n);
  let maxTernaryError = 0;
  let maxLedgerError = 0;
  for (let i = 0; i < n; i += 1) {
    const ternary = trits[i] * gamma;
    const led = trits[i] * decodedScale;
    reconstructed[i] = led;
    maxTernaryError = Math.max(maxTernaryError, Math.abs(ternary - values[i]));
    maxLedgerError = Math.max(maxLedgerError, Math.abs(led - values[i]));
  }
  const packed = packCrumbs(trits);
  const scaleBytes = scale.fallback ? 4 : 3;
  return {
    count: n,
    trits,
    packed,
    scale,
    gamma,
    decodedScale,
    reconstructed,
    maxTernaryError,
    maxLedgerError,
    phiScaleError: Math.abs(decodedScale - gamma),
    fp32Bytes: n * 4,
    ledgerBytes: packed.length + scaleBytes
  };
}

export function ledgerWithOutliers(floats, budget = 0.05, options = {}) {
  const values = Float32Array.from(floats);
  const n = values.length;
  const outlier = new Uint8Array(n);
  const trits = new Int8Array(n);
  let gamma = 0;
  for (let pass = 0; pass < 4; pass += 1) {
    let absSum = 0;
    let kept = 0;
    for (let i = 0; i < n; i += 1) {
      if (outlier[i]) continue;
      absSum += Math.abs(values[i]);
      kept += 1;
    }
    gamma = kept ? absSum / kept : 0;
    const denom = gamma + 1e-12;
    let marked = 0;
    for (let i = 0; i < n; i += 1) {
      if (outlier[i]) {
        trits[i] = 0;
        continue;
      }
      const q = Math.round(values[i] / denom);
      trits[i] = q > 1 ? 1 : q < -1 ? -1 : q;
      if (Math.abs(values[i] - trits[i] * gamma) > budget) {
        outlier[i] = 1;
        trits[i] = 0;
        marked += 1;
      }
    }
    if (!marked) break;
  }
  const scale = encodeScale(gamma, options.tolerance);
  const decodedScale = decodeScale(scale);
  const reconstructed = new Float32Array(n);
  const slots = [];
  let maxLedgerError = 0;
  for (let i = 0; i < n; i += 1) {
    if (outlier[i]) {
      reconstructed[i] = values[i];
      slots.push(i);
      continue;
    }
    reconstructed[i] = trits[i] * decodedScale;
    maxLedgerError = Math.max(maxLedgerError, Math.abs(reconstructed[i] - values[i]));
  }
  const packed = packCrumbs(trits);
  const scaleBytes = scale.fallback ? 4 : 3;
  const outlierBytes = slots.length * 6;
  return {
    count: n,
    trits,
    packed,
    scale,
    gamma,
    decodedScale,
    reconstructed,
    outlierIndex: slots,
    outlierCount: slots.length,
    maxLedgerError,
    phiScaleError: Math.abs(decodedScale - gamma),
    ledgerBytes: packed.length + scaleBytes + outlierBytes,
    fp32Bytes: n * 4
  };
}

export function ternaryDot(trits, inputs) {
  let acc = 0;
  for (let i = 0; i < trits.length; i += 1) {
    if (trits[i] === 1) acc += inputs[i] || 0;
    else if (trits[i] === -1) acc -= inputs[i] || 0;
  }
  return acc;
}

export function createPhi75Neuron(dim, seedScale = 0.25) {
  return {
    trits: new Int8Array(dim),
    votes: new Int16Array(dim),
    scale: encodeScale(seedScale),
    bias: 0
  };
}

export function predictPhi75(neuron, x) {
  return decodeScale(neuron.scale) * ternaryDot(neuron.trits, x) + neuron.bias;
}

export function lossPhi75(neuron, batch) {
  if (!batch.length) return 0;
  let sum = 0;
  for (const row of batch) {
    const err = predictPhi75(neuron, row.x) - row.y;
    sum += err * err;
  }
  return sum / batch.length;
}

function cloneNeuron(neuron, trits, votes, scale, bias) {
  return { trits, votes, scale, bias };
}

export function trainPhi75(neuron, batch, options = {}) {
  const lr = options.lr ?? 0.35;
  const trip = options.trip ?? 4;
  const before = lossPhi75(neuron, batch);
  const scale = decodeScale(neuron.scale) || 1e-6;
  const gradW = new Float64Array(neuron.trits.length);
  let gradB = 0;
  let gradScale = 0;
  const n = Math.max(1, batch.length);
  for (const row of batch) {
    const err = predictPhi75(neuron, row.x) - row.y;
    gradB += err;
    gradScale += err * ternaryDot(neuron.trits, row.x);
    for (let i = 0; i < neuron.trits.length; i += 1) gradW[i] += err * scale * (row.x[i] || 0);
  }
  const nextVotes = Int16Array.from(neuron.votes || new Int16Array(neuron.trits.length));
  const nextTrits = Int8Array.from(neuron.trits);
  for (let i = 0; i < nextTrits.length; i += 1) {
    const push = -gradW[i];
    if (push > 0) nextVotes[i] += 1;
    else if (push < 0) nextVotes[i] -= 1;
    if (nextVotes[i] >= trip && nextTrits[i] < 1) {
      nextTrits[i] += 1;
      nextVotes[i] = 0;
    } else if (nextVotes[i] <= -trip && nextTrits[i] > -1) {
      nextTrits[i] -= 1;
      nextVotes[i] = 0;
    }
  }
  const nextBias = neuron.bias - (lr * gradB) / n;
  const snapped = encodeScale(scale - (lr * gradScale) / n, options.tolerance);
  const candidates = [
    neuron,
    cloneNeuron(neuron, nextTrits, nextVotes, neuron.scale, nextBias),
    cloneNeuron(neuron, nextTrits, nextVotes, snapped, nextBias)
  ];
  let best = neuron;
  let bestLoss = before;
  for (const candidate of candidates) {
    const loss = candidate === neuron ? before : lossPhi75(candidate, batch);
    if (loss < bestLoss - 1e-15) {
      best = candidate;
      bestLoss = loss;
    }
  }
  const kept = best !== neuron;
  if (kept) {
    neuron.trits = best.trits;
    neuron.votes = best.votes;
    neuron.scale = best.scale;
    neuron.bias = best.bias;
  }
  return {
    kept,
    before,
    after: bestLoss,
    scale: decodeScale(neuron.scale),
    form: neuron.scale.form,
    trits: Array.from(neuron.trits)
  };
}
