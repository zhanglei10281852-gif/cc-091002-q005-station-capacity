import test from 'node:test';
import assert from 'node:assert/strict';
import { CapacityStore } from '../src/capacity-store.js';
import { CapacityService } from '../src/capacity-service.js';

const makeService = (zone) => new CapacityService(new CapacityStore(zone));
const baseZone = { id: 'ZONE-A', material: 'mixed-household', limitKg: 10000, stockKg: 4000 };

test('并发预约同一库区时检查与落账原子化，不会双双超发', async () => {
  const service = makeService(baseZone); // 可用 6000
  const [a, b] = await Promise.all([
    service.reserve({ id: 'R-1', expectedKg: 3500 }),
    service.reserve({ id: 'R-2', expectedKg: 3500 }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), ['held', 'rejected']);
  const rejected = [a, b].find((r) => r.status === 'rejected');
  assert.equal(rejected.reason, 'capacity');
  assert.ok(rejected.snapshot, '拒绝必须携带容量快照');
  assert.equal(service.available(), 2500);
});

test('故事回归：两车同时预约并进场，站内存量不超过安全上限', async () => {
  const service = makeService(baseZone); // 可用 6000
  const [r1, r2] = await Promise.all([
    service.reserve({ id: 'R-1', expectedKg: 4000 }),
    service.reserve({ id: 'R-2', expectedKg: 4000 }),
  ]);
  assert.equal([r1, r2].filter((r) => r.status === 'held').length, 1);
  const heldId = r1.status === 'held' ? 'R-1' : 'R-2';
  await service.arrive(heldId, 4000);
  const snap = service.snapshot();
  assert.ok(snap.stockKg <= snap.limitKg);
  assert.ok(snap.availableKg >= 0);
});

test('同一单据重复预约：相同请求幂等返回，不同请求拒绝', async () => {
  const service = makeService(baseZone);
  assert.equal((await service.reserve({ id: 'R-1', expectedKg: 2000 })).status, 'held');
  const replay = await service.reserve({ id: 'R-1', expectedKg: 2000 });
  assert.equal(replay.status, 'held');
  assert.equal(replay.idempotent, true);
  assert.equal(service.snapshot().heldKg, 2000); // 没有重复预占
  const dup = await service.reserve({ id: 'R-1', expectedKg: 3000 });
  assert.equal(dup.status, 'rejected');
  assert.equal(dup.reason, 'duplicate-id');
});

test('物料类别与库区不符时拒绝预约', async () => {
  const service = makeService(baseZone);
  const r = await service.reserve({ id: 'R-9', expectedKg: 100, material: 'hazardous' });
  assert.equal(r.status, 'rejected');
  assert.equal(r.reason, 'material-mismatch');
});

test('实际净重低于预约时按实际落地并释放差额', async () => {
  const service = makeService(baseZone);
  await service.reserve({ id: 'R-1', expectedKg: 3000 });
  const r = await service.arrive('R-1', 2500);
  assert.equal(r.status, 'arrived');
  assert.equal(r.confirmedKg, 2500);
  assert.equal(r.pendingKg, 0);
  assert.equal(service.available(), 3500); // 10000 - 4000 - 2500，预占与实际之差 500 已释放
});

test('实际净重高于预约时在安全范围内补占', async () => {
  const service = makeService(baseZone);
  await service.reserve({ id: 'R-1', expectedKg: 2000 }); // 可用 4000
  const r = await service.arrive('R-1', 4500); // 超出 2500，可用 4000 足够补占
  assert.equal(r.status, 'arrived');
  assert.equal(r.confirmedKg, 4500);
  assert.equal(r.pendingKg, 0);
  assert.equal(service.available(), 1500); // 10000 - 4000 - 4500
});

test('补占超出安全上限时超出部分转入待处置，且不出现负容量', async () => {
  const service = makeService(baseZone);
  await service.reserve({ id: 'R-1', expectedKg: 2000 });
  const r = await service.arrive('R-1', 9000); // 可安全落地 = 4000 可用 + 2000 预占 = 6000
  assert.equal(r.status, 'arrived');
  assert.equal(r.confirmedKg, 6000);
  assert.equal(r.pendingKg, 3000);
  assert.match(r.message, /待处置/);
  const snap = service.snapshot();
  assert.equal(snap.stockKg, 10000); // 恰好顶到上限
  assert.equal(snap.pendingKg, 3000);
  assert.equal(snap.availableKg, 0);
  assert.ok(snap.availableKg >= 0, '可用容量不能为负');
});

test('进场确认幂等：重复上报同一净重不重复落地，净重冲突则拒绝', async () => {
  const service = makeService(baseZone);
  await service.reserve({ id: 'R-1', expectedKg: 2000 });
  await service.arrive('R-1', 2100);
  const again = await service.arrive('R-1', 2100);
  assert.equal(again.idempotent, true);
  assert.equal(service.snapshot().stockKg, 6100);
  const conflict = await service.arrive('R-1', 2200);
  assert.equal(conflict.status, 'rejected');
  assert.equal(conflict.reason, 'invalid-state');
  assert.equal(service.snapshot().stockKg, 6100);
});

test('取消预约立即释放预占吨位，重复取消幂等', async () => {
  const service = makeService(baseZone);
  await service.reserve({ id: 'R-1', expectedKg: 5000 });
  assert.equal(service.available(), 1000);
  const c = await service.cancel('R-1');
  assert.equal(c.status, 'cancelled');
  assert.equal(c.releasedKg, 5000);
  assert.equal(service.available(), 6000); // 立即释放，而不是隔日
  const again = await service.cancel('R-1');
  assert.equal(again.status, 'cancelled');
  assert.equal(again.releasedKg, 0);
  assert.equal(service.available(), 6000);
  const arrived = await service.reserve({ id: 'R-2', expectedKg: 100 });
  assert.equal(arrived.status, 'held');
  await service.arrive('R-2', 100);
  const cannotCancel = await service.cancel('R-2');
  assert.equal(cannotCancel.status, 'rejected');
  assert.equal(cannotCancel.reason, 'invalid-state');
});

test('调整预约吨位：上调受容量约束，下调立即释放', async () => {
  const service = makeService(baseZone); // 可用 6000
  await service.reserve({ id: 'R-1', expectedKg: 3000 }); // 可用 3000
  assert.equal((await service.adjust('R-1', { expectedKg: 5500 })).status, 'adjusted');
  assert.equal(service.available(), 500);
  const no = await service.adjust('R-1', { expectedKg: 8000 }); // 需再补 2500 > 500
  assert.equal(no.status, 'rejected');
  assert.equal(no.reason, 'capacity');
  assert.equal(no.snapshot.availableKg, 500);
  assert.equal(service.snapshot().heldKg, 5500); // 原预占未被破坏
  assert.equal((await service.adjust('R-1', { expectedKg: 4000 })).status, 'adjusted');
  assert.equal(service.available(), 2000);
});

test('过期任务释放到期预占，故障恢复后重跑不会重复释放', async () => {
  const service = makeService(baseZone);
  await service.reserve({ id: 'R-1', expectedKg: 2000, expiresAt: '2026-09-18T08:00:00+08:00' });
  await service.reserve({ id: 'R-2', expectedKg: 1000, expiresAt: '2026-09-18T20:00:00+08:00' });
  const first = await service.expireDue('2026-09-18T12:00:00+08:00');
  assert.deepEqual(first.expired.map((x) => x.id), ['R-1']);
  assert.equal(first.releasedKg, 2000);
  assert.equal(service.available(), 5000); // 6000 - 1000(R-2 仍有效)
  const rerun = await service.expireDue('2026-09-18T12:00:00+08:00'); // 故障恢复后重跑
  assert.equal(rerun.expired.length, 0);
  assert.equal(rerun.releasedKg, 0);
  assert.equal(service.available(), 5000);
});

test('过期释放的容量立即可供新预约使用', async () => {
  const service = makeService(baseZone);
  await service.reserve({ id: 'R-1', expectedKg: 6000, expiresAt: '2026-09-18T08:00:00+08:00' });
  assert.equal((await service.reserve({ id: 'R-2', expectedKg: 1000 })).status, 'rejected');
  await service.expireDue('2026-09-18T09:00:00+08:00');
  assert.equal((await service.reserve({ id: 'R-2', expectedKg: 1000 })).status, 'held');
});

test('过期与到场竞争只有一个结果：预占只被处理一次', async () => {
  // 到场先落账：过期任务不再释放
  const a = makeService(baseZone);
  await a.reserve({ id: 'R-1', expectedKg: 2000, expiresAt: '2026-09-18T08:00:00+08:00' });
  await a.arrive('R-1', 2000);
  const exp = await a.expireDue('2026-09-18T12:00:00+08:00');
  assert.equal(exp.releasedKg, 0);
  assert.equal(a.snapshot().stockKg, 6000);

  // 过期先落账：车辆按无预占进场，容量足够仍可安全落地
  const b = makeService(baseZone);
  await b.reserve({ id: 'R-1', expectedKg: 2000, expiresAt: '2026-09-18T08:00:00+08:00' });
  await b.expireDue('2026-09-18T12:00:00+08:00');
  const arr = await b.arrive('R-1', 2000);
  assert.equal(arr.status, 'arrived');
  assert.equal(arr.arrivedAfterExpiry, true);
  assert.equal(b.snapshot().stockKg, 6000);
  assert.equal(b.available(), 4000);
});

test('过期任务与车辆到场并发时结果唯一且容量守恒', async () => {
  const service = makeService(baseZone);
  await service.reserve({ id: 'R-1', expectedKg: 2000, expiresAt: '2026-09-18T08:00:00+08:00' });
  await Promise.all([
    service.arrive('R-1', 2000),
    service.expireDue('2026-09-18T12:00:00+08:00'),
  ]);
  const snap = service.snapshot();
  // 无论哪个先落账，终态一致：净重落地 2000，预占只释放一次
  assert.equal(snap.stockKg, 6000);
  assert.equal(snap.heldKg, 0);
  assert.equal(snap.availableKg, 4000);
});

test('出库转运减少落地存量，同一单据重放幂等', async () => {
  const service = makeService(baseZone);
  assert.equal((await service.outbound({ id: 'OUT-1', kg: 1500 })).status, 'outbound');
  assert.equal(service.snapshot().stockKg, 2500);
  const replay = await service.outbound({ id: 'OUT-1', kg: 1500 });
  assert.equal(replay.idempotent, true);
  assert.equal(service.snapshot().stockKg, 2500); // 不重复扣减
  const tooMuch = await service.outbound({ id: 'OUT-2', kg: 9999 });
  assert.equal(tooMuch.status, 'rejected');
  assert.equal(tooMuch.reason, 'stock-insufficient');
  assert.equal(tooMuch.snapshot.stockKg, 2500);
});

test('出库释放的容量可继续预约', async () => {
  const service = makeService(baseZone); // 存量 4000，可用 6000
  await service.reserve({ id: 'R-1', expectedKg: 6000 }); // 可用 0
  await service.outbound({ id: 'OUT-1', kg: 3000 }); // 存量 1000，可用 3000
  assert.equal((await service.reserve({ id: 'R-2', expectedKg: 3000 })).status, 'held');
  assert.equal(service.available(), 0);
});

test('待处置量可经处置出库核销', async () => {
  const service = makeService(baseZone);
  await service.reserve({ id: 'R-1', expectedKg: 2000 });
  await service.arrive('R-1', 9000); // 待处置 3000
  const d = await service.outbound({ id: 'DSP-1', kg: 3000, source: 'pending' });
  assert.equal(d.status, 'outbound');
  assert.equal(service.snapshot().pendingKg, 0);
  const tooMuch = await service.outbound({ id: 'DSP-2', kg: 1, source: 'pending' });
  assert.equal(tooMuch.status, 'rejected');
  assert.equal(tooMuch.reason, 'pending-insufficient');
});

test('容量不足拒绝时返回可解释的容量快照', async () => {
  const service = makeService(baseZone);
  await service.reserve({ id: 'R-1', expectedKg: 5000 });
  const r = await service.reserve({ id: 'R-2', expectedKg: 2000 });
  assert.equal(r.status, 'rejected');
  assert.equal(r.reason, 'capacity');
  assert.ok(r.message);
  assert.deepEqual(
    {
      limitKg: r.snapshot.limitKg,
      stockKg: r.snapshot.stockKg,
      heldKg: r.snapshot.heldKg,
      pendingKg: r.snapshot.pendingKg,
      availableKg: r.snapshot.availableKg,
    },
    { limitKg: 10000, stockKg: 4000, heldKg: 5000, pendingKg: 0, availableKg: 1000 },
  );
});

test('班长可随时核对上限、已落地存量、有效预占与待处置量', async () => {
  const service = makeService(baseZone);
  await service.reserve({ id: 'R-1', expectedKg: 2000 });
  await service.reserve({ id: 'R-2', expectedKg: 1500 });
  await service.arrive('R-1', 2600); // 补占 600
  await service.cancel('R-2');
  await service.reserve({ id: 'R-3', expectedKg: 1000 });
  const s = service.snapshot();
  assert.equal(s.limitKg, 10000);
  assert.equal(s.stockKg, 6600);
  assert.equal(s.heldKg, 1000);
  assert.equal(s.pendingKg, 0);
  assert.equal(s.availableKg, 2400);
  assert.equal(s.activeHolds, 1);
});

test('随机操作序列下容量不变量始终成立', async () => {
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const service = makeService({ id: 'ZONE-A', material: 'mixed-household', limitKg: 10000, stockKg: 1000 });
  const ids = [];
  for (let i = 0; i < 200; i += 1) {
    const pick = rand();
    if (pick < 0.35) {
      const id = `R-${i}`;
      ids.push(id);
      await service.reserve({
        id,
        expectedKg: 1 + Math.floor(rand() * 3000),
        expiresAt: `2026-09-18T${String(8 + (i % 12)).padStart(2, '0')}:00:00+08:00`,
      });
    } else if (pick < 0.55 && ids.length > 0) {
      await service.arrive(ids[Math.floor(rand() * ids.length)], Math.floor(rand() * 4000));
    } else if (pick < 0.7 && ids.length > 0) {
      await service.cancel(ids[Math.floor(rand() * ids.length)]);
    } else if (pick < 0.8) {
      await service.expireDue('2026-09-18T15:00:00+08:00');
    } else if (pick < 0.9) {
      await service.outbound({ id: `OUT-${i}`, kg: Math.floor(rand() * 2000) });
    } else if (ids.length > 0) {
      await service.adjust(ids[Math.floor(rand() * ids.length)], { expectedKg: 1 + Math.floor(rand() * 3000) });
    }
    const s = service.snapshot();
    assert.ok(s.availableKg >= 0, `可用容量不能为负: ${JSON.stringify(s)}`);
    assert.ok(s.stockKg >= 0 && s.pendingKg >= 0 && s.heldKg >= 0);
    assert.equal(s.stockKg + s.heldKg + s.availableKg, s.limitKg, '容量必须守恒');
  }
});
