# 第二阶段：策略、登记与本地经营界面

## 启动

需要 Node.js 26+。在项目根目录运行：

```sh
npm ci
npm start
```

打开 `http://127.0.0.1:19888`。开发模式使用 `npm run dev`，Node 自动监听服务端依赖变化；前端静态文件修改后刷新浏览器。

配置项：

| 环境变量 | 默认值 | 用途 |
|---|---|---|
| PORT | 19888 | 1024～65535 的监听端口 |
| HOST | 127.0.0.1 | 本地监听地址 |
| DATABASE_PATH | data/app.db | SQLite 文件；测试可用 :memory: |
| DEMO_SEED | true | 设为 false 时关闭自动演示数据填充 |

种子仅对空数据库执行一次，包含两家模拟门店、两位店长、六位客户、近 30 天策略、60 张模拟存根及过去 29 天决议。当天保留待核验，方便体验“登记 → 决议 → 账单”的流程。重启读取原有数据，跨天不会自动编造新的策略或决议。Vue 3 从本地依赖提供，无需加载外部 CDN。

这是本地功能演示。界面中的店长切换用于选择模拟操作身份，没有正式登录、会话鉴权或管理员权限控制；它不构成真实账号隔离。模块会验证门店、店长与客户的归属关系。所有写操作为本地数据登记与计算。

## 深模块接口

- `createStrategyModule(db)`：发布策略、按日期读取策略和决议、生成日历；`generateCalendar` 是纯函数，底层保留泛型 `StrategyEvaluator<TInput, TOutcome>`。
- `createStoreModule(db)`：创建和读取 Store、StoreManager、Client，以及按店查询。实体归属固定，当前没有跨店迁移或删除功能。
- `createRegistryModule(db, stores, strategy)`：登记存根、记录决议、批量结算、列出账单及汇总。
- `buildApp(options)`：将模块接到 Fastify REST API 与静态页面，便于独立 HTTP 注入测试。

SQLite 适配器封装记录存取、Date 序列化和事务。数据库写事务使用 BEGIN IMMEDIATE；嵌套调用使用保存点，登记、批量结算和首次种子填充均能整体回滚。

## 明确的业务口径

1. 日历包含截至指定日期的连续 30 天，按日期升序排列，用 UTC 日历运算避免夏令时漂移；默认业务日期为 Asia/Shanghai。
2. 同日三组组合任意一个与决议三位字符串完全相等，则为 Hit，否则为 Miss。`038` 与 `083` 不相等。策略或决议缺失时，条目 `status` 为 null、页面显示“待核验”，不将缺失资料解释成 Miss；OutcomeStatus 自身仍只有 Hit/Miss。
3. 策略按日期及 ID 唯一发布。已发布或已存在决议的日期拒绝重新发布，保持历史可复核。
4. 登记验证店长、客户、门店关联。采纳策略须存在同日策略且所选代码属于三组之一。已有决议的日期拒绝新增存根；HTTP 入口还拒绝登记未来业务日期。
5. 录入决议在同一事务中处理该日期全部门店的订单，每张存根调用第一阶段 calculateSettlement。任一计算失败，不留下半批账单或决议。
6. 相同决议重试返回已有账单；不同号码或基准产出的冲突决议返回 409。当前不提供改判、撤销或补录已决议日期的入口。
7. 分润按单张存根核算后按店累加，不跨存根轧差。netGain 沿用第一阶段最低为 0 的口径，表示正向净收益，不表示实际盈亏总额。clientNetGain = netGain − performanceFee，表示扣费后的正向收益。日期与门店汇总都不能被当作扣除全部亏损后的投资回报。
8. 金额始终以 BigInt 分计算，汇总也校验安全范围与 number 往返精度；服务费等于店长激励与平台留存之和（以分核对）。

## REST API

所有请求与响应为 JSON。创建实体由服务端生成 UUID 和适用的 createdAt；OrderSlip 的 storeId 从 managerId 推导。

| 方法 | 路径 | 功能 |
|---|---|---|
| GET | /api/health | 健康检查 |
| GET | /api/bootstrap | 业务日期、演示标识、门店和店长 |
| GET | /api/portfolios/:date | 当日策略或 null |
| GET | /api/calendar?endDate=YYYY-MM-DD | 连续 30 天日历及比对资料 |
| GET | /api/stores/:storeId/clients | 本店客户 |
| GET | /api/stores/:storeId/orders | 本店存根及登记店长 |
| GET | /api/stores/:storeId/bills | 本店逐单分润账单 |
| GET | /api/stores/:storeId/summary | 本店累计金额、笔数和分润 |
| POST | /api/stores | { name, address? } |
| POST | /api/managers | { storeId, name } |
| POST | /api/clients | { storeId, name } |
| POST | /api/portfolios | { date, combos: [{ code, weight, note? }, …] }，恰好三组 |
| POST | /api/orders | { managerId, clientId, date, selectedCode, quantity, totalAmount, adoptedStrategy } |
| POST | /api/resolutions | { date, settlementCode, quotaPerUnit } |

错误格式为 `{ "error": "具体说明" }`：输入错误 400、缺失记录 404、业务冲突 409、计算精度超界 422。未知内部错误返回通用提示。请求体限制 32 KiB；来自其他 Origin 的页面写请求被拒绝。

## 验证

```sh
npm run typecheck
npm run test:coverage
```

测试覆盖第一阶段全部 70 项用例，以及策略、门店、登记、事务持久化和 HTTP 流程。真实 SQLite 文件关闭后重开、同一决议重复提交、计算溢出回滚均通过公开接口验证。多进程并发竞态未作压力测试。

页面验收使用 Codex 内置浏览器。桌面 1280×900、手机 390×844；截图保存在 `docs/qa/phase2/`。临时内存实例用于登记与决议提交，默认 `data/app.db` 保留可继续体验的当天待核验数据。

本次本地交付延续现有非 Git 工作区；未提交、推送、创建 PR 或部署远程服务。
