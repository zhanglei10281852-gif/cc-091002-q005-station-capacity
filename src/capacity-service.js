/**
 * 转运站库区容量服务。
 *
 * 容量模型（同一库区）：
 *   可用容量 availableKg = limitKg - stockKg - heldKg
 *   不变量：stockKg + heldKg <= limitKg，即 availableKg 永不为负。
 *
 * 待处置量 pendingKg 是进场净重超出安全上限、未能落地的部分：
 * 单独记账、等待处置分流，不参与可用容量扣减，也绝不允许把可用容量压成负数。
 *
 * 同一库区的所有变更（预占、确认、调整、过期、取消、出库）都按库区串行执行，
 * 容量检查与落账在同一个同步临界区内完成：并发请求只有一个先落账，其余请求
 * 看到落账后的最新容量再判定，从根上消除超发与重复释放。
 */

const isPositiveFinite = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
const isNonNegativeFinite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isBlankId = (value) => typeof value !== 'string' || value.length === 0;
const isUnparseableDate = (value) => Number.isNaN(new Date(value).getTime());

// 串行队列按库区（store）维度维护：即使多个服务实例包装同一库区，决策依然原子化。
const zoneQueues = new WeakMap();

export class CapacityService {
  constructor(store) {
    this.store = store;
  }

  // ---------- 查询 ----------

  /** 有效预占合计：仅统计 held 状态的预约。 */
  heldKg() {
    let total = 0;
    for (const item of this.store.reservations.values()) {
      if (item.state === 'held') total += item.expectedKg;
    }
    return total;
  }

  /** 当前可用容量，永不为负。 */
  available() {
    return this.store.zone.limitKg - this.store.zone.stockKg - this.heldKg();
  }

  /** 班长核对视图：上限、已落地存量、有效预占、待处置量与可用容量。 */
  snapshot() {
    const { zone } = this.store;
    const heldKg = this.heldKg();
    let activeHolds = 0;
    for (const item of this.store.reservations.values()) {
      if (item.state === 'held') activeHolds += 1;
    }
    return {
      zoneId: zone.id,
      material: zone.material,
      limitKg: zone.limitKg,
      stockKg: zone.stockKg,
      heldKg,
      pendingKg: zone.pendingKg,
      availableKg: zone.limitKg - zone.stockKg - heldKg,
      activeHolds,
    };
  }

  // ---------- 变更入口：统一排队，保证同一库区并发决策原子化 ----------

  reserve(input) {
    return this.#enqueue(() => this.#reserve(input));
  }

  arrive(id, actualKg) {
    return this.#enqueue(() => this.#arrive(id, actualKg));
  }

  adjust(id, patch) {
    return this.#enqueue(() => this.#adjust(id, patch));
  }

  cancel(id) {
    return this.#enqueue(() => this.#cancel(id));
  }

  expireDue(now = new Date()) {
    return this.#enqueue(() => this.#expireDue(now));
  }

  outbound(input) {
    return this.#enqueue(() => this.#outbound(input));
  }

  #enqueue(op) {
    const previous = zoneQueues.get(this.store) ?? Promise.resolve();
    const result = previous.then(op);
    // 单个操作失败（返回 rejected 或抛错）不阻塞后续操作。
    zoneQueues.set(this.store, result.catch(() => {}));
    return result;
  }

  // ---------- 内部实现：均为同步临界区，检查与落账不可被并发打断 ----------

  #reject(reason, message, extra = {}) {
    return { status: 'rejected', reason, message, ...extra, snapshot: this.snapshot() };
  }

  /** 每项容量变动都关联业务单据并记录台账，便于核对与故障后审计。 */
  #record(type, id, detail = {}) {
    const snap = this.snapshot();
    this.store.ledger.push({
      seq: this.store.ledger.length + 1,
      type,
      id,
      at: new Date().toISOString(),
      ...detail,
      stockKg: snap.stockKg,
      heldKg: snap.heldKg,
      pendingKg: snap.pendingKg,
      availableKg: snap.availableKg,
    });
  }

  #reserve(input) {
    const { zone } = this.store;
    if (!input || isBlankId(input.id)) {
      return this.#reject('invalid-input', '预约缺少有效的单据编号');
    }
    if (!isPositiveFinite(input.expectedKg)) {
      return this.#reject('invalid-input', '预约吨位必须为正数', { id: input.id });
    }
    if (input.expiresAt !== undefined && input.expiresAt !== null && isUnparseableDate(input.expiresAt)) {
      return this.#reject('invalid-input', '预约有效期无法解析', { id: input.id });
    }
    if (input.material !== undefined && input.material !== zone.material) {
      return this.#reject('material-mismatch', `物料类别「${input.material}」与库区「${zone.material}」不符`, { id: input.id });
    }
    const existing = this.store.reservations.get(input.id);
    if (existing) {
      const sameRequest = existing.state === 'held'
        && existing.expectedKg === input.expectedKg
        && existing.expiresAt === (input.expiresAt ?? null);
      if (sameRequest) {
        // 同一单据的重复提交幂等返回，不重复预占。
        return { status: 'held', id: existing.id, expectedKg: existing.expectedKg, idempotent: true, snapshot: this.snapshot() };
      }
      return this.#reject('duplicate-id', '单据编号已存在，如需变更吨位请使用调整接口', { id: input.id });
    }
    if (this.available() < input.expectedKg) {
      return this.#reject('capacity', '可用容量不足，预约未落账', { id: input.id, requestedKg: input.expectedKg });
    }
    const record = {
      id: input.id,
      material: input.material ?? zone.material,
      expectedKg: input.expectedKg,
      expiresAt: input.expiresAt ?? null,
      state: 'held',
      heldAt: new Date().toISOString(),
    };
    this.store.reservations.set(record.id, record);
    this.#record('reserve', record.id, { expectedKg: record.expectedKg });
    return { status: 'held', id: record.id, expectedKg: record.expectedKg, snapshot: this.snapshot() };
  }

  #arrive(id, actualKg) {
    if (!isNonNegativeFinite(actualKg)) {
      return this.#reject('invalid-input', '实际净重必须为非负数值', { id });
    }
    const item = this.store.reservations.get(id);
    if (!item) {
      return this.#reject('not-found', '预约不存在', { id });
    }
    if (item.state === 'arrived') {
      if (item.actualKg === actualKg) {
        // 地磅重复上报同一净重：幂等返回，不重复落地。
        return {
          status: 'arrived',
          id,
          actualKg: item.actualKg,
          confirmedKg: item.confirmedKg,
          pendingKg: item.overflowKg,
          idempotent: true,
          snapshot: this.snapshot(),
        };
      }
      return this.#reject('invalid-state', '该预约已完成进场确认，净重不一致请走异常处置流程', { id });
    }
    if (item.state === 'cancelled') {
      return this.#reject('invalid-state', '预约已取消，不能进场', { id });
    }
    // held：本车可安全落地空间 = 当前可用容量 + 释放掉的自身预占；
    // expired：过期任务已释放预占（过期与到场的竞争只有一个结果），按无预占车辆处理。
    const wasHeld = item.state === 'held';
    const holdKg = wasHeld ? item.expectedKg : 0;
    const roomKg = this.available() + holdKg;
    // 实际净重高于预约时在安全范围内补占；超出安全上限的部分转入待处置，绝不让可用容量变负。
    const confirmedKg = Math.min(actualKg, roomKg);
    const overflowKg = actualKg - confirmedKg;
    item.state = 'arrived';
    item.actualKg = actualKg;
    item.confirmedKg = confirmedKg;
    item.overflowKg = overflowKg;
    item.arrivedAfterExpiry = !wasHeld;
    item.arrivedAt = new Date().toISOString();
    this.store.zone.stockKg += confirmedKg;
    this.store.zone.pendingKg += overflowKg;
    this.#record('arrive', id, { actualKg, confirmedKg, overflowKg, holdKg });
    return {
      status: 'arrived',
      id,
      actualKg,
      confirmedKg,
      pendingKg: overflowKg,
      holdReleasedKg: holdKg,
      arrivedAfterExpiry: !wasHeld,
      ...(overflowKg > 0 ? { message: '超出安全上限的部分已转入待处置' } : {}),
      snapshot: this.snapshot(),
    };
  }

  #adjust(id, patch = {}) {
    const item = this.store.reservations.get(id);
    if (!item) {
      return this.#reject('not-found', '预约不存在', { id });
    }
    if (item.state !== 'held') {
      return this.#reject('invalid-state', '仅有效预占可以调整', { id, state: item.state });
    }
    if (patch.expectedKg !== undefined) {
      if (!isPositiveFinite(patch.expectedKg)) {
        return this.#reject('invalid-input', '调整后的预约吨位必须为正数', { id });
      }
      const deltaKg = patch.expectedKg - item.expectedKg;
      if (deltaKg > 0 && this.available() < deltaKg) {
        return this.#reject('capacity', '可用容量不足，无法上调预约吨位', { id, requestedDeltaKg: deltaKg });
      }
      item.expectedKg = patch.expectedKg;
      this.#record('adjust', id, { deltaKg });
    }
    if (patch.expiresAt !== undefined) {
      if (patch.expiresAt !== null && isUnparseableDate(patch.expiresAt)) {
        return this.#reject('invalid-input', '预约有效期无法解析', { id });
      }
      item.expiresAt = patch.expiresAt;
      this.#record('adjust-expiry', id, { expiresAt: patch.expiresAt });
    }
    return { status: 'adjusted', id, expectedKg: item.expectedKg, expiresAt: item.expiresAt, snapshot: this.snapshot() };
  }

  #cancel(id) {
    const item = this.store.reservations.get(id);
    if (!item) {
      return this.#reject('not-found', '预约不存在', { id });
    }
    if (item.state === 'cancelled') {
      // 重复取消幂等返回，不重复释放。
      return { status: 'cancelled', id, releasedKg: 0, idempotent: true, snapshot: this.snapshot() };
    }
    if (item.state !== 'held') {
      return this.#reject('invalid-state', '当前状态不能取消', { id, state: item.state });
    }
    item.state = 'cancelled';
    item.cancelledAt = new Date().toISOString();
    item.releasedKg = item.expectedKg;
    this.#record('cancel', id, { releasedKg: item.expectedKg });
    return { status: 'cancelled', id, releasedKg: item.releasedKg, snapshot: this.snapshot() };
  }

  #expireDue(now) {
    const ts = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(ts.getTime())) {
      return this.#reject('invalid-input', '过期任务的基准时间无法解析');
    }
    const expired = [];
    for (const item of this.store.reservations.values()) {
      // 状态守卫：只有 held 会释放预占；已到场、已取消、已过期的记录不会被
      // 重复释放，因此故障恢复后重跑本任务是安全的，与到场竞争也只有一个结果。
      if (item.state === 'held' && item.expiresAt !== null && new Date(item.expiresAt).getTime() <= ts.getTime()) {
        item.state = 'expired';
        item.expiredAt = ts.toISOString();
        item.releasedKg = item.expectedKg;
        expired.push({ id: item.id, releasedKg: item.expectedKg });
        this.#record('expire', item.id, { releasedKg: item.expectedKg });
      }
    }
    return {
      status: 'ok',
      expired,
      releasedKg: expired.reduce((total, item) => total + item.releasedKg, 0),
      snapshot: this.snapshot(),
    };
  }

  #outbound(input) {
    const { zone } = this.store;
    if (!input || isBlankId(input.id)) {
      return this.#reject('invalid-input', '出库缺少有效的单据编号');
    }
    if (!isPositiveFinite(input.kg)) {
      return this.#reject('invalid-input', '出库重量必须为正数', { id: input.id });
    }
    const source = input.source ?? 'stock';
    if (source !== 'stock' && source !== 'pending') {
      return this.#reject('invalid-input', '出库来源只能是 stock（落地存量）或 pending（待处置）', { id: input.id });
    }
    const done = this.store.documents.get(input.id);
    if (done) {
      if (done.kg === input.kg && done.source === source) {
        // 同一出库单据重放：幂等返回，不重复扣减。
        return { status: 'outbound', id: input.id, kg: done.kg, source: done.source, idempotent: true, snapshot: this.snapshot() };
      }
      return this.#reject('duplicate-id', '出库单据编号已使用', { id: input.id });
    }
    if (source === 'stock') {
      if (input.kg > zone.stockKg) {
        return this.#reject('stock-insufficient', '已落地存量不足，出库未执行', { id: input.id, requestedKg: input.kg });
      }
      zone.stockKg -= input.kg;
    } else {
      if (input.kg > zone.pendingKg) {
        return this.#reject('pending-insufficient', '待处置量不足，处置未执行', { id: input.id, requestedKg: input.kg });
      }
      zone.pendingKg -= input.kg;
    }
    this.store.documents.set(input.id, { type: 'outbound', source, kg: input.kg, at: new Date().toISOString() });
    this.#record('outbound', input.id, { source, kg: input.kg });
    return { status: 'outbound', id: input.id, kg: input.kg, source, snapshot: this.snapshot() };
  }
}
