export type Verdict = "not_task" | "task" | "task_incomplete";

export interface ContextMessage {
  messageId: string; // full resource name: spaces/AAA/messages/BBB
  sender: "me" | "them";
  senderName: string;
  text: string;
  createTime: string; // ISO 8601
  quoted?: { senderName: string; text: string };
}

export interface ClassifierInput {
  spaceId: string;
  trigger: ContextMessage;
  context: ContextMessage[]; // chronological, trigger is last element
  nowIst: string; // e.g. "2026-07-18T14:30:00+05:30"
}

export interface Classification {
  verdict: Verdict;
  title: string | null;
  dueDate: string | null; // YYYY-MM-DD
  requester: string | null;
  confidence: number; // 0..1
  reasoning: string;
}

export type DetectionStatus =
  | "incomplete"
  | "pending"
  | "confirmed"
  | "dismissed"
  | "expired";

export interface Detection {
  id: string; // trigger messageId with "/" replaced by "_"
  spaceId: string;
  messageIds: string[];
  contextSnapshot: ContextMessage[];
  verdict: Verdict;
  title: string | null;
  dueDate: string | null;
  requester: string | null;
  status: DetectionStatus;
  sourceLink: string; // https://chat.google.com deep link
  createdAt: string;
  updatedAt: string;
}
