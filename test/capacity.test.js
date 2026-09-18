import test from 'node:test';
import assert from 'node:assert/strict';
import { CapacityStore } from '../src/capacity-store.js';
import { CapacityService } from '../src/capacity-service.js';

const FUTURE = '2027-01-01T00:00:00+08:00';
const T0 = Date.parse('2026-09-18T08:00:00+08:00');

const makeService = (zone, now) =>
  new CapacityService(new CapacityStore({ id: 'ZONE-T', material: 'mixed-household', ...zone }), now ? { now } : undefined);

const assertInvariant = (service) => {
  const m = service.monitor();
  assert.ok(m.availableKg >= 0, `可用容量为负: ${m.availableKg}`);
  assert.ok(m.stockKg >= 0 && m.heldKg >= 0 && m.pendingKg >= 0, '账面出现负值');
  assert.ok(m.stockKg + m.heldKg <= m.limitKg, '落地存量+有效预占超过上限');
  return m;
};

test('并发预约只有一单能拿到容量（两车同时进场场景）', async () => {
  const service = makeService({ limitKg: 10000, stockKg: 4000 });
  const results = await Promise.all([
    service.reserve({ id: 'A', expectedKg: 3500, expiresAt: FUTURE }),
    service.reserve({ id: 'B', expectedKg: 3500, expiresAt: FUTURE }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['held', 'rejected']);
  const rejected = results.find((r) => r.status === 'rejected');
  assert.equal(rejected.reason, 'capacity');
  assert.equal(rejected.snapshot.availableKg, 2500);
  assert.equal(service.available(), 2500);
  // 实际净重高于预约：安全范围内补占
  const arrived = await service.arrive('A', 3800);
  assert.equal(arrived.absorbedKg, 300);
  assert.equal(arrived.overflowKg, 0);
  assert.equal(service.monitor().stockKg, 7800);
  assertInvariant(service);
});

test('取消预约立即释放预占，无需等定时任务', async () => {
  const service = makeService({ limitKg: 10000, stockKg: 4000 });
  await service.reserve({ id: 'R', expectedKg: 2000, expiresAt: FUTURE });
  assert.equal(service.available(), 4000);
  const cancelled = await service.cancel('R');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(service.available(), 6000);
  assert.equal(service.monitor().heldKg, 0);
  const again = await service.reserve({ id: 'R2', expectedKg: 6000, expiresAt: FUTURE });
  assert.equal(again.status, 'held');
  // 重复取消幂等
  const repeat = await service.cancel('R');
  assert.equal(repeat.status, 'cancelled');
});

test('过期任务释放预占且幂等，故障恢复后重跑不会重复释放', async () => {
  let now = T0;
  const store = new CapacityStore({ id: 'ZONE-T', material: 'mixed-household', limitKg: 10000, stockKg: 4000 });
  const service = new CapacityService(store, { now: () => now });
  await service.reserve({ id: 'R1', expectedKg: 2000, expiresAt: T0 + 2 * 3600_000 });
  await service.reserve({ id: 'R2', expectedKg: 1500, expiresAt: T0 + 2 * 3600_000 });
  assert.equal(service.available(), 2500); // 未到期仍计入有效预占
  now = T0 + 3 * 3600_000;
  const first = await service.expireDue();
  assert.deepEqual(first.expired.sort(), ['R1', 'R2']);
  assert.equal(service.available(), 6000);
  const again = await service.expireDue();
  assert.deepEqual(again.expired, []);
  assert.equal(service.available(), 6000);
  // 模拟故障重启：从快照恢复后重跑过期任务
  const restored = new CapacityService(CapacityStore.restore(store.snapshot()), { now: () => now });
  const afterRestore = await restored.expireDue();
  assert.deepEqual(afterRestore.expired, []);
  assert.equal(restored.available(), 6000);
  assert.equal(restored.monitor().heldKg, 0);
  const released = restored.store.events.filter((e) => e.type === 'expire').map((e) => e.docId).sort();
  assert.deepEqual(released, ['R1', 'R2']);
});

test('过期与车辆到场竞争只有一个结果', async () => {
  // 过期任务先执行：到场被拒绝，存量不变
  let now = T0;
  const s1 = makeService({ limitKg: 10000, stockKg: 4000 }, () => now);
  await s1.reserve({ id: 'R', expectedKg: 2000, expiresAt: T0 + 4 * 3600_000 });
  now = T0 + 5 * 3600_000;
  const [exp, arr] = await Promise.all([s1.expireDue(), s1.arrive('R', 2000)]);
  assert.deepEqual(exp.expired, ['R']);
  assert.equal(arr.status, 'rejected');
  assert.equal(arr.reason, 'expired');
  assert.equal(s1.monitor().stockKg, 4000);
  assert.equal(s1.available(), 6000);
  assert.equal(s1.store.events.filter((e) => e.type === 'expire' && e.docId === 'R').length, 1);

  // 到场先执行：过期任务不再释放
  let now2 = T0;
  const s2 = makeService({ limitKg: 10000, stockKg: 4000 }, () => now2);
  await s2.reserve({ id: 'R', expectedKg: 2000, expiresAt: T0 + 4 * 3600_000 });
  const [arr2] = await Promise.all([s2.arrive('R', 2000), s2.expireDue()]);
  assert.equal(arr2.status, 'arrived');
  now2 = T0 + 5 * 3600_000;
  const later = await s2.expireDue();
  assert.deepEqual(later.expired, []);
  assert.equal(s2.monitor().stockKg, 6000);

  // 已过期且到场先进入队列：到场的惰性清扫使其被拒绝，过期任务无事可做
  let now3 = T0;
  const s3 = makeService({ limitKg: 10000, stockKg: 4000 }, () => now3);
  await s3.reserve({ id: 'R', expectedKg: 2000, expiresAt: T0 + 4 * 3600_000 });
  now3 = T0 + 5 * 3600_000;
  const [arr3, exp3] = await Promise.all([s3.arrive('R', 2000), s3.expireDue()]);
  assert.equal(arr3.status, 'rejected');
  assert.equal(arr3.reason, 'expired');
  assert.deepEqual(exp3.expired, []);
  assert.equal(s3.store.events.filter((e) => e.type === 'expire' && e.docId === 'R').length, 1);
  assertInvariant(s3);
});

test('实际净重高于预约时安全范围内补占，超出部分转待处置且不出现负容量', async () => {
  const service = makeService({ limitKg: 10000, stockKg: 4000 });
  await service.reserve({ id: 'R1', expectedKg: 2000, expiresAt: FUTURE });
  await service.reserve({ id: 'R2', expectedKg: 3800, expiresAt: FUTURE });
  assert.equal(service.available(), 200);
  const arrived = await service.arrive('R1', 2600); // 超重 600：补占 200，待处置 400
  assert.equal(arrived.absorbedKg, 200);
  assert.equal(arrived.overflowKg, 400);
  const m = assertInvariant(service);
  assert.equal(m.stockKg, 6200);
  assert.equal(m.heldKg, 3800);
  assert.equal(m.pendingKg, 400);
  assert.equal(m.availableKg, 0);
});

test('实际净重低于预约时立即释放差额', async () => {
  const service = makeService({ limitKg: 10000, stockKg: 4000 });
  await service.reserve({ id: 'R', expectedKg: 2000, expiresAt: FUTURE });
  const arrived = await service.arrive('R', 1200);
  assert.equal(arrived.absorbedKg, 0);
  assert.equal(arrived.overflowKg, 0);
  const m = assertInvariant(service);
  assert.equal(m.stockKg, 5200);
  assert.equal(m.availableKg, 4800);
});

test('调整预约：调增受容量约束，调减立即释放', async () => {
  const service = makeService({ limitKg: 10000, stockKg: 4000 });
  await service.reserve({ id: 'R', expectedKg: 2000, expiresAt: FUTURE });
  const up = await service.adjust('R', 5000);
  assert.equal(up.status, 'adjusted');
  assert.equal(service.available(), 1000);
  const tooMuch = await service.adjust('R', 9000);
  assert.equal(tooMuch.status, 'rejected');
  assert.equal(tooMuch.reason, 'capacity');
  assert.equal(tooMuch.snapshot.availableKg, 1000);
  const down = await service.adjust('R', 1500);
  assert.equal(down.status, 'adjusted');
  assert.equal(service.available(), 4500);
  assertInvariant(service);
});

test('出库优先消化待处置量，拒绝超量与重复单据', async () => {
  const service = makeService({ limitKg: 10000, stockKg: 4000, pendingKg: 300 });
  const out = await service.outbound('T-1', 500);
  assert.equal(out.status, 'outbound');
  assert.equal(out.fromPendingKg, 300);
  assert.equal(out.fromStockKg, 200);
  const m = assertInvariant(service);
  assert.equal(m.pendingKg, 0);
  assert.equal(m.stockKg, 3800);
  const dup = await service.outbound('T-1', 100);
  assert.equal(dup.status, 'rejected');
  assert.equal(dup.reason, 'duplicate-id');
  const tooMuch = await service.outbound('T-2', 99999);
  assert.equal(tooMuch.status, 'rejected');
  assert.equal(tooMuch.reason, 'insufficient-stock');
  assert.equal(tooMuch.snapshot.stockKg, 3800);
});

test('拒绝返回可解释的容量快照，非法输入与状态冲突可区分', async () => {
  const service = makeService({ limitKg: 10000, stockKg: 4000 });
  await service.reserve({ id: 'R1', expectedKg: 5500, expiresAt: FUTURE });
  const noCapacity = await service.reserve({ id: 'R2', expectedKg: 1000, expiresAt: FUTURE });
  assert.equal(noCapacity.status, 'rejected');
  for (const key of ['limitKg', 'stockKg', 'heldKg', 'pendingKg', 'availableKg']) {
    assert.ok(Number.isFinite(noCapacity.snapshot[key]), key);
  }
  assert.equal(noCapacity.snapshot.heldKg, 5500);
  assert.equal(noCapacity.snapshot.availableKg, 500);
  assert.equal((await service.reserve({ id: 'R1', expectedKg: 100, expiresAt: FUTURE })).reason, 'duplicate-id');
  assert.equal(
    (await service.reserve({ id: 'R3', expectedKg: 100, expiresAt: FUTURE, material: 'industrial' })).reason,
    'material-mismatch',
  );
  assert.equal((await service.arrive('NOPE', 100)).reason, 'not-found');
  assert.equal((await service.arrive('R1', -5)).reason, 'invalid-input');
  const arrived = await service.arrive('R1', 5500);
  assert.equal(arrived.status, 'arrived');
  assert.equal((await service.cancel('R1')).reason, 'invalid-state');
  assert.equal((await service.arrive('R1', 100)).reason, 'invalid-state');
  assertInvariant(service);
});

test('班长可随时核对上限、已落地存量、有效预占和待处置量', async () => {
  const service = makeService({ limitKg: 10000, stockKg: 4000 });
  await service.reserve({ id: 'R1', expectedKg: 2000, expiresAt: FUTURE });
  await service.reserve({ id: 'R2', expectedKg: 3800, expiresAt: FUTURE });
  await service.arrive('R1', 2600);
  const m = service.monitor();
  assert.deepEqual(
    { limitKg: m.limitKg, stockKg: m.stockKg, heldKg: m.heldKg, pendingKg: m.pendingKg },
    { limitKg: 10000, stockKg: 6200, heldKg: 3800, pendingKg: 400 },
  );
  assert.equal(m.availableKg, 0);
  // 每项变化均关联业务单据，seq 单调递增
  const seqs = service.store.events.map((e) => e.seq);
  assert.ok(service.store.events.every((e) => e.docId));
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.deepEqual([...new Set(seqs)].length, seqs.length);
});

test('随机操作下容量不变量始终成立', async () => {
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let now = T0;
  const service = makeService({ limitKg: 8000, stockKg: 1000 }, () => now);
  const ids = [];
  for (let i = 0; i < 200; i += 1) {
    const op = Math.floor(rand() * 6);
    now += Math.floor(rand() * 3600_000);
    if (op === 0) {
      const id = `F${i}`;
      ids.push(id);
      await service.reserve({ id, expectedKg: Math.ceil(rand() * 3000), expiresAt: now + 3600_000 });
    } else if (op === 1 && ids.length) {
      await service.arrive(ids[Math.floor(rand() * ids.length)], Math.ceil(rand() * 4000));
    } else if (op === 2 && ids.length) {
      await service.cancel(ids[Math.floor(rand() * ids.length)]);
    } else if (op === 3 && ids.length) {
      await service.adjust(ids[Math.floor(rand() * ids.length)], Math.ceil(rand() * 3000));
    } else if (op === 4) {
      await service.expireDue();
    } else {
      await service.outbound(`T${i}`, Math.ceil(rand() * 2000));
    }
    assertInvariant(service);
  }
});
