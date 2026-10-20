import { createMind, think } from "../index.js";

const goals = ["14 - 9", "100 - 37", "6 * 7", "8 / 2", "remember studio = fraymus", "recall studio", "recall nowhere", "what is the capital"];
let mind = createMind();
for (const goal of goals) {
  const report = think(mind, goal);
  mind = report.mind;
  const phases = report.steps.map((step) => step.phase).join(",");
  console.log(`${report.verdict.padEnd(10)} ${goal.padEnd(28)} ${phases}  got=${report.got}`);
}
console.log("opcodes", mind.opcodes);
