export class CapacityStore {
  constructor(zone) {
    this.zone = structuredClone(zone);
    // 待处置量：进场净重超出安全上限、未能落地而等待处置分流的部分。
    this.zone.pendingKg ??= 0;
    this.reservations = new Map();
    // 已处理的业务单据（出库等），用于故障重放时的幂等判断。
    this.documents = new Map();
    // 容量变动台账：每项变化均关联业务单据，便于班长核对与故障后审计。
    this.ledger = [];
  }

  snapshot() {
    return {
      zone: structuredClone(this.zone),
      reservations: [...this.reservations.values()].map((item) => structuredClone(item)),
      documents: [...this.documents.entries()].map(([id, doc]) => ({ id, ...structuredClone(doc) })),
      ledger: this.ledger.map((entry) => structuredClone(entry)),
    };
  }
}
