const REJECT_MESSAGES = {
  'capacity': '可用容量不足，请求超过库区安全上限',
  'insufficient-stock': '出库量超过站内存量与待处置量之和',
  'not-found': '预约单据不存在',
  'invalid-state': '预约当前状态不允许该操作',
  'expired': '预约已超过有效期，预占被回收',
  'invalid-input': '请求参数不合法',
  'material-mismatch': '物料类别与库区不符',
  'duplicate-id': '业务单据编号重复',
};

// 同一库区的所有变更经此串行队列执行，且临界区内不出现 await，
// 因此每次“检查-变更”对并发调用而言是原子的，不会出现两车同时通过容量检查。
class Mutex {
  #tail = Promise.resolve();
  run(task) {
    const result = this.#tail.then(task);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export class CapacityService {
  constructor(store, options = {}) {
    this.store = store;
    this.now = options.now ?? (() => Date.now());
    this.mutex = new Mutex();
  }

  // 有效预占：仍处于 held 状态的预约吨位之和
  heldKg() {
    let total = 0;
    for (const item of this.store.reservations.values()) {
      if (item.state === 'held') total += item.expectedKg;
    }
    return total;
  }

  available() {
    const { limitKg, stockKg } = this.store.zone;
    return limitKg - stockKg - this.heldKg();
  }

  // 班长核对视图：上限 / 已落地存量 / 有效预占 / 待处置量 / 可用容量
  monitor() {
    const { id, material, limitKg, stockKg, pendingKg } = this.store.zone;
    const heldKg = this.heldKg();
    return {
      zoneId: id,
      material,
      limitKg,
      stockKg,
      heldKg,
      pendingKg,
      availableKg: limitKg - stockKg - heldKg,
    };
  }

  // 所有拒绝都携带可解释的容量快照
  #reject(reason, detail = {}) {
    return {
      status: 'rejected',
      reason,
      message: REJECT_MESSAGES[reason] ?? reason,
      ...detail,
      snapshot: this.monitor(),
    };
  }

  // 过期清扫：held 且到达有效期的预约转为 expired 并立即释放预占。
  // 状态单向流转（held -> expired），定时任务重跑或故障恢复后重放都不会二次释放。
  #sweepExpired(at) {
    const expired = [];
    for (const item of this.store.reservations.values()) {
      if (item.state === 'held' && item.expiresAtMs <= at) {
        item.state = 'expired';
        item.closedAt = at;
        expired.push(item.id);
        this.store.record('expire', item.id, { at, releasedKg: item.expectedKg });
      }
    }
    return expired;
  }

  // 预占：检查与写入在同一临界区内完成，并发预约不会突破上限
  async reserve(input) {
    return this.mutex.run(() => {
      this.#sweepExpired(this.now());
      const { id, expectedKg, expiresAt, material } = input ?? {};
      const expiresAtMs = typeof expiresAt === 'number' ? expiresAt : Date.parse(expiresAt);
      if (!id || !Number.isFinite(expectedKg) || expectedKg <= 0 || !Number.isFinite(expiresAtMs)) {
        return this.#reject('invalid-input', { id });
      }
      if (material !== undefined && material !== this.store.zone.material) {
        return this.#reject('material-mismatch', { id });
      }
      if (this.store.reservations.has(id)) return this.#reject('duplicate-id', { id });
      if (this.available() < expectedKg) return this.#reject('capacity', { id });
      const at = this.now();
      this.store.reservations.set(id, {
        id,
        expectedKg,
        expiresAt,
        expiresAtMs,
        material: material ?? this.store.zone.material,
        state: 'held',
        createdAt: at,
      });
      this.store.record('reserve', id, { at, expectedKg, expiresAtMs });
      return { status: 'held', id, expectedKg, snapshot: this.monitor() };
    });
  }

  // 调整：调增需容量充足，调减立即释放差额
  async adjust(id, nextExpectedKg) {
    return this.mutex.run(() => {
      this.#sweepExpired(this.now());
      if (!Number.isFinite(nextExpectedKg) || nextExpectedKg <= 0) {
        return this.#reject('invalid-input', { id });
      }
      const item = this.store.reservations.get(id);
      if (!item) return this.#reject('not-found', { id });
      if (item.state === 'expired') return this.#reject('expired', { id });
      if (item.state !== 'held') return this.#reject('invalid-state', { id, state: item.state });
      const deltaKg = nextExpectedKg - item.expectedKg;
      if (deltaKg > 0 && this.available() < deltaKg) return this.#reject('capacity', { id });
      item.expectedKg = nextExpectedKg;
      this.store.record('adjust', id, { at: this.now(), expectedKg: nextExpectedKg, deltaKg });
      return { status: 'adjusted', id, expectedKg: nextExpectedKg, deltaKg, snapshot: this.monitor() };
    });
  }

  // 确认（进场称重）：实际净重替换预占。超重部分先在可用容量内补占，
  // 补占不了的部分转入待处置；欠载差额立即释放。可用容量不会为负。
  async arrive(id, actualKg) {
    return this.mutex.run(() => {
      this.#sweepExpired(this.now());
      if (!Number.isFinite(actualKg) || actualKg < 0) return this.#reject('invalid-input', { id });
      const item = this.store.reservations.get(id);
      if (!item) return this.#reject('not-found', { id });
      if (item.state === 'expired') return this.#reject('expired', { id });
      if (item.state !== 'held') return this.#reject('invalid-state', { id, state: item.state });
      const zone = this.store.zone;
      const excessKg = actualKg - item.expectedKg;
      const absorbedKg = Math.min(Math.max(excessKg, 0), this.available());
      const overflowKg = Math.max(excessKg, 0) - absorbedKg;
      const at = this.now();
      item.state = 'arrived';
      item.actualKg = actualKg;
      item.absorbedKg = absorbedKg;
      item.overflowKg = overflowKg;
      item.arrivedAt = at;
      zone.stockKg += actualKg - overflowKg; // 超出安全上限的部分不计入落地存量，挂入待处置
      zone.pendingKg += overflowKg;
      this.store.record('arrive', id, { at, actualKg, absorbedKg, overflowKg });
      return {
        status: 'arrived',
        id,
        actualKg,
        expectedKg: item.expectedKg,
        absorbedKg,
        overflowKg,
        snapshot: this.monitor(),
      };
    });
  }

  // 取消：立即释放预占，重复取消幂等
  async cancel(id) {
    return this.mutex.run(() => {
      this.#sweepExpired(this.now());
      const item = this.store.reservations.get(id);
      if (!item) return this.#reject('not-found', { id });
      if (item.state === 'cancelled') {
        return { status: 'cancelled', id, already: true, snapshot: this.monitor() };
      }
      if (item.state === 'expired') return this.#reject('expired', { id });
      if (item.state !== 'held') return this.#reject('invalid-state', { id, state: item.state });
      item.state = 'cancelled';
      item.closedAt = this.now();
      this.store.record('cancel', id, { at: item.closedAt, releasedKg: item.expectedKg });
      return { status: 'cancelled', id, releasedKg: item.expectedKg, snapshot: this.monitor() };
    });
  }

  // 过期任务：与车辆到场竞争时经同一队列串行，只有先执行者生效
  async expireDue(at = this.now()) {
    return this.mutex.run(() => {
      const expired = this.#sweepExpired(at);
      return { status: 'expired', expired, snapshot: this.monitor() };
    });
  }

  // 出库：优先消化待处置量，再扣落地存量；同一出库单据只执行一次
  async outbound(docId, amountKg) {
    return this.mutex.run(() => {
      this.#sweepExpired(this.now());
      if (!docId || !Number.isFinite(amountKg) || amountKg <= 0) {
        return this.#reject('invalid-input', { id: docId });
      }
      if (this.store.outboundDocs.has(docId)) return this.#reject('duplicate-id', { id: docId });
      const zone = this.store.zone;
      if (amountKg > zone.stockKg + zone.pendingKg) {
        return this.#reject('insufficient-stock', { id: docId });
      }
      const fromPendingKg = Math.min(zone.pendingKg, amountKg);
      const fromStockKg = amountKg - fromPendingKg;
      zone.pendingKg -= fromPendingKg;
      zone.stockKg -= fromStockKg;
      this.store.outboundDocs.add(docId);
      this.store.record('outbound', docId, { at: this.now(), amountKg, fromStockKg, fromPendingKg });
      return { status: 'outbound', id: docId, amountKg, fromStockKg, fromPendingKg, snapshot: this.monitor() };
    });
  }
}
