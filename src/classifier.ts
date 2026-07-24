import { GoogleGenAI, Type } from "@google/genai";
import type { ClassifierInput, Classification, Verdict } from "./types.js";
import type { Config } from "./config.js";

const VERDICTS: Verdict[] = ["not_task", "task", "task_incomplete"];

export function buildPrompt(input: ClassifierInput): string {
  const lines = input.context.map((m) => {
    const who = m.sender === "me" ? `ME (${m.senderName})` : m.senderName;
    const quoted = m.quoted
      ? `\n   [quoting ${m.quoted.senderName}: "${m.quoted.text}"]`
      : "";
    const marker = m.messageId === input.trigger.messageId ? ">>> " : "    ";
    return `${marker}[${m.createTime}] ${who}: ${m.text}${quoted}`;
  });
  return `You are TaskLens, a task detector for a software developer's Google Chat DMs.
Messages may be in English, Hindi, or Hinglish (code-mixed).
Today's date/time in IST is ${input.nowIst}.

Below is a DM conversation. The message marked with ">>>" is the one to classify.
Lines starting with "ME" were written by the user themself — they are context,
never tasks for the user.

${lines.join("\n")}

Classify the ">>>" message:
- "task": someone is asking the user to do something, and there is enough detail
  to state what the work is. Examples of task phrasing: "isko dekh lena",
  "kal tak chahiye", "please fix this", "jab free ho tab kar dena",
  "change this word to that".
- "task_incomplete": it is clearly a request, but a person could NOT act on it
  yet — the what/where is missing (e.g. "change the word to this" with no file
  or page named anywhere in the context).
- "not_task": conversation, questions, FYI, status updates, greetings.

Rules:
- Derive the title from the WHOLE context (especially quoted messages), not just
  the ">>>" line. "isko dekh lena" quoting "login page pe error" =>
  title "Fix error on login page".
- dueDate: resolve relative dates against today's IST date ("kal tak" =>
  tomorrow, "EOD" => today). Format YYYY-MM-DD. null if no deadline given.
- requester: the display name of the person asking.
- When unsure between not_task and task, lean toward task.
- Write title and reasoning in English.`;
}

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    verdict: { type: Type.STRING, enum: VERDICTS as string[] },
    title: { type: Type.STRING, nullable: true },
    dueDate: { type: Type.STRING, nullable: true },
    requester: { type: Type.STRING, nullable: true },
    confidence: { type: Type.NUMBER },
    reasoning: { type: Type.STRING },
  },
  required: ["verdict", "title", "dueDate", "requester", "confidence", "reasoning"],
};

export function parseClassification(raw: string): Classification {
  const o = JSON.parse(raw);
  if (!VERDICTS.includes(o.verdict)) throw new Error(`invalid verdict: ${o.verdict}`);
  if (o.dueDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(o.dueDate))
    throw new Error(`invalid dueDate: ${o.dueDate}`);
  return {
    verdict: o.verdict,
    title: o.title ?? null,
    dueDate: o.dueDate ?? null,
    requester: o.requester ?? null,
    confidence: typeof o.confidence === "number" ? o.confidence : 0,
    reasoning: String(o.reasoning ?? ""),
  };
}

export async function classify(
  input: ClassifierInput,
  cfg: Config,
): Promise<Classification> {
  const ai = new GoogleGenAI({ apiKey: cfg.geminiApiKey });
  const res = await ai.models.generateContent({
    model: cfg.geminiModel,
    contents: buildPrompt(input),
    config: { responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA },
  });
  return parseClassification(res.text ?? "{}");
}
