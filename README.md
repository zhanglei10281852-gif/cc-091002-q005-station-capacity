# 转运站容量管理

服务按库区管理实际存量、车辆预约预占和待处置重量。预约有明确有效期，车辆入场后由实际净重替换预占重量，出库转运减少落地存量；每项变化均关联业务单据。

`src/capacity-store.js` 保存库区与预约，`src/capacity-service.js` 执行容量变更，领域样例位于 `fixtures/zone.json`。项目要求 Node.js 20 或更高版本，运行 `npm test` 可检查顺序预约流程。

## 容量模型

- 不变量：`已落地存量 + 有效预占 ≤ 库区上限`，任何操作都不会让可用容量为负。
- 可用容量 = 上限 − 已落地存量 − 有效预占；待处置量单独记账，不挤占可用容量。
- 同一库区的所有变更经串行队列原子执行，检查与变更之间不会让出事件循环，并发决策只有一个生效。

## 操作

- `reserve({id, expectedKg, expiresAt, material?})` 预占：容量不足、物料类别不符、单号重复即拒绝。
- `adjust(id, nextExpectedKg)` 调整：调增需容量充足，调减立即释放差额。
- `arrive(id, actualKg)` 确认（进场称重）：实际净重高于预约时，超出部分先在可用容量内补占，补占不了的部分转入待处置；欠载差额立即释放。
- `cancel(id)` 取消：立即释放预占，重复取消幂等。
- `expireDue(at?)` 过期：回收全部到期预占；状态单向流转（held → expired），故障恢复后重跑不会重复释放；与车辆到场竞争时只有先执行者生效。
- `outbound(docId, amountKg)` 出库：优先消化待处置量，再扣落地存量；同一出库单据只执行一次。

所有拒绝返回 `{status: 'rejected', reason, message, snapshot}`，快照包含上限、已落地存量、有效预占、待处置量与可用容量。`monitor()` 可随时读取同一视图；`store.snapshot()` 与 `CapacityStore.restore(snapshot)` 用于故障恢复，事件日志 `store.events` 记录每次变更及其业务单据。
