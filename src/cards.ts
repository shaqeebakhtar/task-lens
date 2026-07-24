import type { Detection } from "./types.js";

export function confirmationCard(d: Detection, unclear = false): object {
  const header = unclear ? "🤔 Possible task, details unclear" : "📋 Task detected";
  const widgets: object[] = [
    { decoratedText: { topLabel: "Task", text: d.title ?? "(no title)", wrapText: true } },
    { decoratedText: { topLabel: "From", text: d.requester ?? "Unknown" } },
  ];
  if (d.dueDate) widgets.push({ decoratedText: { topLabel: "Due", text: d.dueDate } });
  widgets.push({
    buttonList: {
      buttons: [
        {
          text: "✅ Create task",
          onClick: { action: { function: "confirm_task",
            parameters: [{ key: "detectionId", value: d.id }] } },
        },
        {
          text: "❌ Not a task",
          onClick: { action: { function: "dismiss_task",
            parameters: [{ key: "detectionId", value: d.id }] } },
        },
        { text: "Open message", onClick: { openLink: { url: d.sourceLink } } },
      ],
    },
  });
  return {
    cardsV2: [{
      cardId: d.id,
      card: { header: { title: header }, sections: [{ widgets }] },
    }],
  };
}

const line = (d: Detection) =>
  `• ${d.title ?? "(no title)"}${d.dueDate ? ` (due ${d.dueDate})` : ""} — ${d.requester ?? "?"}`;

export function digestMessage(
  created: Detection[], pending: Detection[], unresolved: Detection[],
): object {
  if (!created.length && !pending.length && !unresolved.length)
    return { text: "☀️ Morning digest: all clear — no tasks captured yesterday, nothing pending." };
  const parts: string[] = ["☀️ *Morning digest*"];
  if (created.length) parts.push(`\n*Created yesterday:*\n${created.map(line).join("\n")}`);
  if (pending.length)
    parts.push(`\n*Still awaiting your ✅/❌:*\n${pending.map(line).join("\n")}`);
  if (unresolved.length)
    parts.push(`\n*Unclear, never resolved:*\n${unresolved.map(line).join("\n")}`);
  return { text: parts.join("\n") };
}
