# 转运站容量管理

服务按库区管理实际存量、车辆预约预占和待处置重量。预约有明确有效期，车辆入场后由实际净重替换预占重量，出库转运减少落地存量；每项变化均关联业务单据。

`src/capacity-store.js` 保存库区与预约，`src/capacity-service.js` 执行容量变更，领域样例位于 `fixtures/zone.json`。项目要求 Node.js 20 或更高版本，运行 `npm test` 可检查顺序预约流程。
