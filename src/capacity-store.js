export class CapacityStore {
  constructor(zone, seed = {}) {
    // pendingKg：待处置量，超重且无法补占的部分挂入此账，不挤占可用容量
    this.zone = { pendingKg: 0, ...structuredClone(zone) };
    this.reservations = new Map();
    this.outboundDocs = new Set();
    this.events = [];
    this.seq = 0;
    for (const item of seed.reservations ?? []) this.reservations.set(item.id, structuredClone(item));
    for (const docId of seed.outboundDocs ?? []) this.outboundDocs.add(docId);
    for (const event of seed.events ?? []) this.events.push(structuredClone(event));
    this.seq = seed.seq ?? this.events.length;
  }

  static restore(snapshot) {
    return new CapacityStore(snapshot.zone, snapshot);
  }

  snapshot() {
    return {
      zone: structuredClone(this.zone),
      reservations: [...this.reservations.values()].map((item) => structuredClone(item)),
      outboundDocs: [...this.outboundDocs],
      events: this.events.map((event) => structuredClone(event)),
      seq: this.seq,
    };
  }

  // 每项容量变化都关联业务单据，seq 单调递增，便于核对与故障恢复后审计
  record(type, docId, detail = {}) {
    this.seq += 1;
    const event = { seq: this.seq, type, docId, ...detail };
    this.events.push(event);
    return event;
  }
}
