# Phase 3：档案归属、事后对账与纸质凭证

> 历史阶段说明：下文演示身份选择已被独立账号登录取代，当前认证接口、权限和验证范围以 [AUTHENTICATION.md](AUTHENTICATION.md) 为准。

领域约束以根目录 `CONTEXT.md`、`SPEC.md` 及 ADR 0002 为准。本阶段在现有深模块公开接口上扩展事后档案与审计功能。

## 启动与体验

Node.js 26+，运行 `npm ci`、`npm start`，打开 `http://127.0.0.1:19888`。开发运行 `npm run dev`。沿用 `PORT`、`HOST`、`DATABASE_PATH` 和 `DEMO_SEED` 配置，默认仅监听本机。

页面顶部选择客户、店长或总部视图。客户只读本人记录；店长查询本店档案与流水、为名下客户建档和记账、记录本店纸质凭证领取；总部查询全局归属和审计，管理门店、店长及原有策略与决议。

角色选择是**本地演示身份**，没有密码登录或真实身份核验。服务端用 HttpOnly、SameSite=Strict 会话 Cookie 绑定当前选择，并逐接口检查读写范围；新选择撤销当前 Cookie 对应的旧会话，会话八小时过期，服务重启后需重选。演示身份目录公开提供用于选择的档案名称及 ID，不返回结余。此配置不应作为对外多用户身份认证系统。

`server.ts` 显式开启 `requireSession: true`。`buildApp` 是可注入的内部应用适配器，默认 `requireSession: false` 保持原有测试调用兼容；缺少 Cookie 的内部调用按可信内部身份处理。新的权限集成测试均显式开启会话要求。客户端视图通过界面和服务端双重限制写操作。

## 深模块与数据规则

### 档案归属

`createStoreModule(db)` 提供建档、读取、归属审计、按日汇总和旧版迁移。`addClient` 接收明确的店长，或者老客户的 `introducedByClientId`，由模块决定最终 `storeId` 与 `managerId`。输入中的归属与来源冲突时拒绝；档案及审计在同一事务写入。客户端不能通过建档传入非零结余。

`ClientAttributionAudit` 追加保存建档或迁移事件。`eventType` 区分 `Created` 和 `Migrated`；汇总的 `newClientCount` 与 `migrationCount` 分开计数，`totalCount` 是归属登记事件总数。业务日期与系统记录时间分别保存。

旧版仅传 `storeId` 的建档调用，在该店恰好有一位店长时继续兼容。启动时迁移旧客户档案，同样只在归属明确时推断店长。未知的原建档日期保持未知，迁移审计注明迁移登记日；重复启动不重复生成审计。归属歧义的旧档案仍可查询，不能用于新建档引荐、收支调整或新存根登记。目前没有重分配归属接口。

### 事后对账

`createReconciliationModule(db, stores)` 的 `adjust` 接收 `{ managerId, clientId, date, direction, amount, note }`，提供 `listForClient`、`listForStore` 和 `listLedger` 查询。

金额必须为正数且最多两位小数，方向使用 `ADJUST_IN` 或 `ADJUST_OUT`。模块校验责任店长、门店和客户归属，在一个写事务内以 BigInt 分计算新结余、拒绝负数及精度超界，再更新客户和追加流水。流水包含原因、业务日期、实际记录时间、操作店长、调整后结余与持久化追加序号 `sequence`。序号保证同一毫秒的多笔登记仍按实际追加顺序呈现。

`balanceAfter` 表示该笔录入完成时的账面结余；补记较早业务日期不会重排已经追加的流水。差错通过另记有原因的调整处理，原流水不修改。对账结余与历史存根及分润账单分别留档，不因存根登记、领取或决议核算而自动增减。

对账 HTTP 接口支持 UUID `Idempotency-Key`。相同店长、相同键与相同请求重试返回原记录，不重复记账；同一键更改内容返回 409。重试记录和余额流水在同一事务提交。前端对内容未变化的失败重试保留该键；刷新页面或切换身份前应核对上次记录，因为前端重试键只保存在页面内存中。

### 纸质凭证

`OrderSlip.voucherStatus` 默认 `StoredInShop`，旧数据读取时自动取得该默认值。`updateVoucherStatus` 允许本店店长记录 `Claimed`，原子追加领取审计；重复确认不重复留痕，已领取不能反向恢复。

原有登记和结算规则保持兼容：已有 `ResolutionEvent` 的日期仍拒绝新增存根。当前支持查询这些历史记录和更新凭证领取状态，不提供该日期的遗漏存根补登记、决议改判或账单重算。

### 追加式存储

SQLite 新增 `client_attribution_audit`、`reconciliation_ledger`、`voucher_audit` 三张审计表。共享存储接口拒绝覆盖，SQL 触发器拒绝 UPDATE / DELETE；批量操作使用现有 BEGIN IMMEDIATE 与嵌套保存点。应用没有编辑或删除审计的接口。这些保护不等同于抵抗拥有数据库文件或管理员权限的篡改，仍需常规备份和文件访问控制。

## Phase 3 接口

| 方法 | 路径 | 作用与范围 |
|---|---|---|
| GET | `/api/demo/identities` | 本地演示身份选择目录 |
| POST | `/api/demo/session` | 选择 `{ role: 'Client', clientId }`、`{ role: 'Manager', managerId }` 或 `{ role: 'HQ' }` |
| GET | `/api/bootstrap` | 返回当前角色范围的档案与业务日期 |
| POST | `/api/clients` | 店长建档；支持引荐自动归属，生成审计 |
| GET | `/api/clients/:clientId` | 查询本人或权限范围内的客户档案与结余 |
| GET | `/api/clients/:clientId/orders` | 查询该客户历史存根与凭证状态 |
| POST | `/api/reconciliations` | 当前责任店长登记事后收支，日期不能在未来 |
| GET | `/api/clients/:clientId/reconciliations` | 客户个人或授权范围内的流水 |
| GET | `/api/stores/:storeId/reconciliations` | 本店或总部范围的流水 |
| PATCH | `/api/orders/:orderId/voucher-status` | 本店店长更新 `{ voucherStatus: 'Claimed' }` |
| GET | `/api/hq/attribution-audits` | `{ audits, summary, totals }`，支持 date / storeId / managerId 过滤 |
| GET | `/api/hq/reconciliations` | 总部审计流水，支持相同过滤条件 |

原有门店查询、事后存根登记和总部管理接口沿用，增加所选角色范围校验。错误码：输入 400、身份未选或过期 401、越权 403、缺失 404、业务冲突 409、金额精度超界 422。

## 种子与兼容验证

全新空库仍含两店、两位店长、六名客户、60 张历史存根和 30 天策略。新增明确的客户归属、引荐审计、八条合成事后收支流水，以及历史凭证领取示例。种子只执行一次；已有数据库不会被补入虚构流水或重新标记凭证。

原有 121 项测试全部保留；两个完整对象断言仅补充新增的 `voucherStatus: 'StoredInShop'` 默认值，没有删除用例或放宽已有校验。新增测试覆盖档案归属、追加式审计、迁移、结余精度、幂等重试、角色范围、凭证状态、种子原子性及持久化。运行 `npm run typecheck` 和 `npm run test:coverage`。浏览器验收记录位于 `docs/qa/phase3/`。
