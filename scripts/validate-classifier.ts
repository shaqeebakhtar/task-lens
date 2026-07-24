import { readFileSync } from "node:fs";
import { classify } from "../src/classifier.js";
import { loadConfig } from "../src/config.js";
import type { ClassifierInput, ContextMessage, Verdict } from "../src/types.js";

interface Sample { text: string; quoted: string | null; prior: string[]; expected: Verdict; }

const file = process.argv[2] ?? "samples/messages.jsonl";
const samples: Sample[] = readFileSync(file, "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));
const cfg = loadConfig();

function toInput(s: Sample, i: number): ClassifierInput {
  const base = Date.now();
  const mk = (text: string, j: number, last: boolean): ContextMessage => ({
    messageId: `spaces/S/messages/${i}-${j}`,
    sender: "them", senderName: "Colleague", text,
    createTime: new Date(base - (10 - j) * 60_000).toISOString(),
    ...(last && s.quoted ? { quoted: { senderName: "Colleague", text: s.quoted } } : {}),
  });
  const context = [...s.prior.map((t, j) => mk(t, j, false)), mk(s.text, s.prior.length, true)];
  return { spaceId: "spaces/S", trigger: context[context.length - 1], context,
    nowIst: new Date().toISOString() };
}

let correct = 0;
for (let i = 0; i < samples.length; i++) {
  const s = samples[i];
  const c = await classify(toInput(s, i), cfg);
  const ok = c.verdict === s.expected;
  if (ok) correct++;
  console.log(`${ok ? "✅" : "❌"} expected=${s.expected} got=${c.verdict} ` +
    `conf=${c.confidence.toFixed(2)} title=${JSON.stringify(c.title)} | ${s.text}`);
  if (!ok) console.log(`   reasoning: ${c.reasoning}`);
}
console.log(`\n${correct}/${samples.length} correct (${Math.round((correct / samples.length) * 100)}%)`);
console.log(`gate: EVERY expected task/task_incomplete must be detected; false positives are tolerable.`);
