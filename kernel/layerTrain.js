// Train one linear layer as a φ ledger.
// The file matrix is the teacher. Each block keeps its own scale pair.
// Outlier floats stay equal to the file. A step is stored only when the
// output error on this batch falls. Votes survive a held step so a trit
// can still flip once the same push has added up.

import { decodeScale, encodeScale, ledgerWithOutliers, packCrumbs } from "./phi75.js";

export function blocksFromWeights(weights, blockSize, budget) {
  if (weights.length % blockSize !== 0) throw new Error("Weight count is not a whole number of blocks");
  const blocks = [];
  for (let offset = 0; offset < weights.length; offset += blockSize) {
    const slice = weights.subarray(offset, offset + blockSize);
    const led = ledgerWithOutliers(slice, budget);
    const outlier = new Uint8Array(blockSize);
    const exact = new Float32Array(blockSize);
    for (const index of led.outlierIndex) {
      outlier[index] = 1;
      exact[index] = slice[index];
    }
    blocks.push({
      trits: led.trits,
      votes: new Int16Array(blockSize),
      scale: led.scale,
      outlier,
      exact
    });
  }
  return blocks;
}

export function reconstructBlocks(blocks, blockSize) {
  const out = new Float32Array(blocks.length * blockSize);
  for (let b = 0; b < blocks.length; b += 1) {
    const block = blocks[b];
    const scale = decodeScale(block.scale);
    const base = b * blockSize;
    for (let i = 0; i < blockSize; i += 1) {
      out[base + i] = block.outlier[i] ? block.exact[i] : block.trits[i] * scale;
    }
  }
  return out;
}

export function fitRowGains(fileWeights, blocks, rows, cols, blockSize, budget) {
  const led = reconstructBlocks(blocks, blockSize);
  const gains = [];
  for (let r = 0; r < rows; r += 1) {
    const base = r * cols;
    let num = 0;
    let den = 0;
    for (let c = 0; c < cols; c += 1) {
      const index = base + c;
      const block = blocks[Math.floor(index / blockSize)];
      if (block.outlier[index % blockSize]) continue;
      const approx = led[index];
      num += fileWeights[index] * approx;
      den += approx * approx;
    }
    let gain = den === 0 ? 1 : num / den;
    if (budget != null) {
      let max = 0;
      for (let c = 0; c < cols; c += 1) {
        const index = base + c;
        const block = blocks[Math.floor(index / blockSize)];
        if (block.outlier[index % blockSize]) continue;
        max = Math.max(max, Math.abs(gain * led[index] - fileWeights[index]));
      }
      if (max > budget + 1e-6) gain = 1;
    }
    gains.push(encodeScale(gain));
  }
  return gains;
}

export function bakeRowGains(blocks, gains, cols, blockSize) {
  for (let b = 0; b < blocks.length; b += 1) {
    const row = Math.floor((b * blockSize) / cols);
    const next = decodeScale(blocks[b].scale) * decodeScale(gains[row]);
    blocks[b].scale = encodeScale(next);
  }
}

export function reconstructWithRowGains(blocks, blockSize, gains, cols) {
  const out = new Float32Array(blocks.length * blockSize);
  for (let b = 0; b < blocks.length; b += 1) {
    const block = blocks[b];
    const scale = decodeScale(block.scale);
    const base = b * blockSize;
    for (let i = 0; i < blockSize; i += 1) {
      const index = base + i;
      if (block.outlier[i]) out[index] = block.exact[i];
      else out[index] = block.trits[i] * scale * decodeScale(gains[Math.floor(index / cols)]);
    }
  }
  return out;
}

export function rowLedger(fileWeights, rows, cols, budget) {
  const blocks = [];
  for (let r = 0; r < rows; r += 1) {
    const slice = fileWeights.subarray(r * cols, (r + 1) * cols);
    const led = ledgerWithOutliers(slice, budget);
    const outlier = new Uint8Array(cols);
    const exact = new Float32Array(cols);
    for (const index of led.outlierIndex) {
      outlier[index] = 1;
      exact[index] = slice[index];
    }
    blocks.push({ trits: led.trits, scale: led.scale, outlier, exact, outlierCount: led.outlierCount, ledgerBytes: led.ledgerBytes });
  }
  return blocks;
}

export function reconstructRows(rowsBlocks) {
  const cols = rowsBlocks[0].trits.length;
  const out = new Float32Array(rowsBlocks.length * cols);
  for (let r = 0; r < rowsBlocks.length; r += 1) {
    const block = rowsBlocks[r];
    const scale = decodeScale(block.scale);
    const base = r * cols;
    for (let c = 0; c < cols; c += 1) out[base + c] = block.outlier[c] ? block.exact[c] : block.trits[c] * scale;
  }
  return out;
}

export function maxInlierError(blocks, fileWeights, blockSize) {
  const led = reconstructBlocks(blocks, blockSize);
  let max = 0;
  for (let i = 0; i < fileWeights.length; i += 1) {
    const block = blocks[Math.floor(i / blockSize)];
    if (block.outlier[i % blockSize]) continue;
    max = Math.max(max, Math.abs(led[i] - fileWeights[i]));
  }
  return max;
}

function applyRow(weights, input, rows, cols, into) {
  for (let r = 0; r < rows; r += 1) {
    let acc = 0;
    const base = r * cols;
    for (let c = 0; c < cols; c += 1) acc += weights[base + c] * input[c];
    into[r] = acc;
  }
}

export function outputLoss(fileWeights, ledgerWeights, inputs, rows, cols) {
  let sum = 0;
  let energy = 0;
  const teacher = new Float32Array(rows);
  const student = new Float32Array(rows);
  for (const input of inputs) {
    applyRow(fileWeights, input, rows, cols, teacher);
    applyRow(ledgerWeights, input, rows, cols, student);
    for (let r = 0; r < rows; r += 1) {
      const err = student[r] - teacher[r];
      sum += err * err;
      energy += teacher[r] * teacher[r];
    }
  }
  const count = Math.max(1, inputs.length * rows);
  return {
    mse: sum / count,
    relative: energy === 0 ? 0 : Math.sqrt(sum / energy)
  };
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeInputs(count, cols, seed) {
  const rand = mulberry32(seed);
  const inputs = [];
  for (let n = 0; n < count; n += 1) {
    const row = new Float32Array(cols);
    for (let c = 0; c < cols; c += 1) row[c] = rand() * 2 - 1;
    inputs.push(row);
  }
  return inputs;
}

function lossOf(blocks, fileWeights, inputs, rows, cols, blockSize) {
  return outputLoss(fileWeights, reconstructBlocks(blocks, blockSize), inputs, rows, cols).mse;
}

function withVotes(blocks, grad, blockSize) {
  return blocks.map((block, b) => {
    const base = b * blockSize;
    const votes = Int16Array.from(block.votes);
    for (let i = 0; i < blockSize; i += 1) {
      if (block.outlier[i]) continue;
      const push = -grad[base + i];
      if (push > 0) votes[i] += 1;
      else if (push < 0) votes[i] -= 1;
    }
    return { trits: block.trits, votes, scale: block.scale, outlier: block.outlier, exact: block.exact };
  });
}

function rankPushes(blocks, grad, blockSize, trip) {
  const ranked = [];
  for (let b = 0; b < blocks.length; b += 1) {
    const block = blocks[b];
    const base = b * blockSize;
    for (let i = 0; i < blockSize; i += 1) {
      if (block.outlier[i]) continue;
      const push = -grad[base + i];
      const ready = push > 0 ? block.votes[i] >= trip : push < 0 ? block.votes[i] <= -trip : false;
      if (!ready) continue;
      const next = push > 0 ? block.trits[i] + 1 : block.trits[i] - 1;
      if (next > 1 || next < -1) continue;
      ranked.push({ b, i, push, abs: Math.abs(grad[base + i]) });
    }
  }
  ranked.sort((a, item) => item.abs - a.abs);
  return ranked;
}

function applyFlips(blocks, ranked, limit) {
  const next = blocks.map((block) => ({
    trits: Int8Array.from(block.trits),
    votes: block.votes,
    scale: block.scale,
    outlier: block.outlier,
    exact: block.exact
  }));
  for (const item of ranked.slice(0, limit)) {
    next[item.b].trits[item.i] += item.push > 0 ? 1 : -1;
    const votes = Int16Array.from(next[item.b].votes);
    votes[item.i] = 0;
    next[item.b].votes = votes;
  }
  return next;
}

function nudgeScales(blocks, grad, blockSize, lr, batchN) {
  return blocks.map((block, b) => {
    const base = b * blockSize;
    let gradScale = 0;
    for (let i = 0; i < blockSize; i += 1) {
      if (block.outlier[i]) continue;
      gradScale += grad[base + i] * block.trits[i];
    }
    return {
      trits: block.trits,
      votes: block.votes,
      scale: encodeScale(decodeScale(block.scale) - (lr * gradScale) / batchN),
      outlier: block.outlier,
      exact: block.exact
    };
  });
}

function accumulateGrad(fileWeights, blocks, inputs, rows, cols, blockSize) {
  const ledger = reconstructBlocks(blocks, blockSize);
  const grad = new Float64Array(fileWeights.length);
  const teacher = new Float32Array(rows);
  const student = new Float32Array(rows);
  for (const input of inputs) {
    applyRow(fileWeights, input, rows, cols, teacher);
    applyRow(ledger, input, rows, cols, student);
    for (let r = 0; r < rows; r += 1) {
      const err = student[r] - teacher[r];
      const base = r * cols;
      for (let c = 0; c < cols; c += 1) grad[base + c] += err * input[c];
    }
  }
  return grad;
}

export function trainLedgerMatrix(blocks, fileWeights, rows, cols, options = {}) {
  const blockSize = options.blockSize ?? blocks[0].trits.length;
  const steps = options.steps ?? 12;
  const lr = options.lr ?? 0.05;
  const trip = options.trip ?? 2;
  const train = options.train ?? makeInputs(8, cols, options.seed ?? 1);
  const held = options.heldOut ?? makeInputs(8, cols, (options.seed ?? 1) + 99);
  const before = outputLoss(fileWeights, reconstructBlocks(blocks, blockSize), train, rows, cols);
  const heldBefore = outputLoss(fileWeights, reconstructBlocks(blocks, blockSize), held, rows, cols);
  let kept = 0;
  for (let step = 0; step < steps; step += 1) {
    const current = lossOf(blocks, fileWeights, train, rows, cols, blockSize);
    const currentHeld = lossOf(blocks, fileWeights, held, rows, cols, blockSize);
    const grad = accumulateGrad(fileWeights, blocks, train, rows, cols, blockSize);
    const voted = withVotes(blocks, grad, blockSize);
    const ranked = rankPushes(voted, grad, blockSize, trip);
    let best = null;
    let bestLoss = current;
    const limits = [];
    for (let limit = Math.min(64, ranked.length); limit >= 1; limit = Math.floor(limit / 8)) limits.push(limit);
    if (ranked.length && limits[limits.length - 1] !== 1) limits.push(1);
    const accept = (candidate) => {
      const loss = lossOf(candidate, fileWeights, train, rows, cols, blockSize);
      const heldLoss = lossOf(candidate, fileWeights, held, rows, cols, blockSize);
      const overBudget = options.budget != null && maxInlierError(candidate, fileWeights, blockSize) > options.budget + 1e-6;
      if (!overBudget && loss < bestLoss - 1e-18 && heldLoss <= currentHeld + 1e-18) {
        best = candidate;
        bestLoss = loss;
        return true;
      }
      return false;
    };
    for (const limit of limits) {
      if (accept(applyFlips(voted, ranked, limit))) break;
    }
    const scaled = nudgeScales(best || voted, grad, blockSize, lr, train.length);
    accept(scaled);
    if (best) {
      for (let b = 0; b < blocks.length; b += 1) {
        blocks[b].trits = best[b].trits;
        blocks[b].votes = best[b].votes;
        blocks[b].scale = best[b].scale;
      }
      kept += 1;
    } else {
      for (let b = 0; b < blocks.length; b += 1) blocks[b].votes = voted[b].votes;
    }
  }
  const afterWeights = reconstructBlocks(blocks, blockSize);
  const after = outputLoss(fileWeights, afterWeights, train, rows, cols);
  const heldAfter = outputLoss(fileWeights, afterWeights, held, rows, cols);
  return {
    blocks,
    before,
    after,
    heldOutBefore: heldBefore,
    heldOutAfter: heldAfter,
    kept,
    steps,
    maxInlierError: maxInlierError(blocks, fileWeights, blockSize)
  };
}

export function checkpointBlocks(blocks) {
  return blocks.map((block) => ({
    e: block.scale.e,
    m: block.scale.m,
    form: block.scale.form,
    raw: block.scale.fallback ? block.scale.raw : undefined,
    crumbs: Buffer.from(packCrumbs(block.trits)).toString("base64"),
    outliers: [...block.outlier].flatMap((flag, index) => (flag ? [[index, block.exact[index]]] : []))
  }));
}
