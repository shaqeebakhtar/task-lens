import type { Detection, DetectionStatus } from "./types.js";

// Minimal slice of the Firestore API we use — keeps the Store decoupled from the
// concrete SDK so it can be constructed with `new Firestore(...) as any`.
export interface DocLike {
  get(): Promise<{ exists: boolean; data(): any }>;
  set(data: any): Promise<unknown>;
  update(patch: any): Promise<unknown>;
}
export interface CollectionLike {
  doc(id: string): DocLike;
  where(field: string, op: "==" | ">=", value: any): {
    get(): Promise<{ docs: Array<{ data(): any }> }>;
    where(field: string, op: "==" | ">=", value: any): {
      get(): Promise<{ docs: Array<{ data(): any }> }>;
    };
  };
}
export interface FirestoreLike { collection(name: string): CollectionLike; }

export class Store {
  constructor(private db: FirestoreLike) {}

  static docId(messageId: string): string { return messageId.replace(/\//g, "_"); }

  async getLastSeen(spaceId: string): Promise<string | null> {
    const snap = await this.db.collection("spaces").doc(Store.docId(spaceId)).get();
    return snap.exists ? (snap.data().lastSeen ?? null) : null;
  }
  async setLastSeen(spaceId: string, iso: string): Promise<void> {
    await this.db.collection("spaces").doc(Store.docId(spaceId)).set({ spaceId, lastSeen: iso });
  }

  async isProcessed(messageId: string): Promise<boolean> {
    return (await this.db.collection("processed").doc(Store.docId(messageId)).get()).exists;
  }
  async markProcessed(messageId: string): Promise<void> {
    await this.db.collection("processed").doc(Store.docId(messageId)).set({ messageId });
  }

  async saveDetection(d: Detection): Promise<void> {
    await this.db.collection("detections").doc(d.id).set(d);
  }
  async updateDetection(id: string, patch: Partial<Detection>): Promise<void> {
    await this.db.collection("detections").doc(id).update(patch);
  }
  async getDetection(id: string): Promise<Detection | null> {
    const snap = await this.db.collection("detections").doc(id).get();
    return snap.exists ? (snap.data() as Detection) : null;
  }
  async listByStatus(status: DetectionStatus): Promise<Detection[]> {
    const r = await this.db.collection("detections").where("status", "==", status).get();
    return r.docs.map((d) => d.data() as Detection);
  }
  async listOpenIncomplete(spaceId: string): Promise<Detection[]> {
    const r = await this.db.collection("detections")
      .where("status", "==", "incomplete").where("spaceId", "==", spaceId).get();
    return r.docs.map((d) => d.data() as Detection);
  }
  async listConfirmedSince(iso: string): Promise<Detection[]> {
    const r = await this.db.collection("detections")
      .where("status", "==", "confirmed").where("updatedAt", ">=", iso).get();
    return r.docs.map((d) => d.data() as Detection);
  }

  async getAuthTokens(): Promise<{ refreshToken: string } | null> {
    const snap = await this.db.collection("auth").doc("user").get();
    return snap.exists ? (snap.data() as { refreshToken: string }) : null;
  }
  async setAuthTokens(t: { refreshToken: string }): Promise<void> {
    await this.db.collection("auth").doc("user").set(t);
  }
}
