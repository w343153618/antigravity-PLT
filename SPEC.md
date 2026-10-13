# SPEC: 连锁门店档案归属与事后对账管理 ERP 技术实现规格说明书 (Phase 3)

- **遵循标准**: Matt Pocock (v1.3.1) `to-spec` Standard
- **对应领域契约**: [CONTEXT.md](./CONTEXT.md)
- **对应架构决策**:
  - [0001-revenue-sharing-and-domain-architecture.md](./docs/adr/0001-revenue-sharing-and-domain-architecture.md)
  - [0002-unified-role-app-referral-and-credit-ledger.md](./docs/adr/0002-unified-role-app-referral-and-credit-ledger.md)

---

## 1. Phase 3 演进范围（严格限定为事后对账与档案管理）

在保持现有 121 项单元测试全部兼容通过的基础上，扩展以下 4 个合规子模块（**不生成任何外部操作**）：

1. **客户档案与归属管理 (`src/modules/store/`)**：
   - 维护门店（`Store`）、店长（`StoreManager`）、客户（`Client`）的归属关系；
   - 支持店长直接建档，或通过老客户引荐建档（`introducedByClientId`）：当指定引荐老客户时，新客户档案自动继承该老客户所属的 `storeId` 与 `managerId`；
   - 记录客户归属与建档审计日志（`ClientAttributionAudit`），支持按日期与店长查询建档与归属统计。

2. **已完成线下业务的事后对账 (`src/modules/reconciliation/`)**：
   - 登记线下实际发生的收支调整（`ADJUST_IN` 增加对账结余 / `ADJUST_OUT` 核减对账结余）；
   - 必填调整金额（精确到分）、调整原因（`note`）、操作店长（`managerId`）与业务日期（`date`）；
   - 采用 `BigInt` 分单位精确计算客户的 `reconciliationBalance`（不允许扣减为负数），并写入不可篡改的追加式审计流水表 `reconciliation_ledger`。

3. **历史凭证查询与领取状态 (`src/modules/registry/`)**：
   - 记录已在线下完成的业务存根（`OrderSlip`），新增纸质凭证领取状态 `voucherStatus: 'StoredInShop' | 'Claimed'`（默认 `'StoredInShop'` 纸质凭证店内存管待取，客户到店取走后由店长更新为 `'Claimed'` 已领取）。

4. **三角色界面与权限视图 (`src/app/client/`)**：
   - **客户视图 (`Client`)**：选择当前客户档案，只读查看自己的对账结余、收支调整审计流水、历史业务存根及纸质凭证领取状态（店内存管待取 / 已领取），查阅今日策略与 30 天红黑历史。
   - **店长视图 (`Manager`)**：管理本店客户档案（支持选择引荐老客户自动继承归属）、登记事后收支调整（`+` / `-` 金额与原因）、登记已完成线下业务存根、一键切换纸质凭证领取状态（标记为“客户已领取”）。
   - **总部视图 (`HQ Admin`)**：查看各门店/店长的客户归属汇总、按日期统计的新增客户建档数与引荐明细、全量对账审计流水，以及发布策略和录入决议。

---

## 2. 核心 Schema 定义 (`src/shared/schemas/`)

### 2.1 客户档案与归属审计 (`store.ts` 扩展)
```typescript
export const ClientSchema = z.object({
  id: z.uuid(),
  storeId: z.uuid(),
  managerId: z.uuid().optional(),
  introducedByClientId: z.uuid().optional(),
  name: z.string().trim().min(1).max(80),
  reconciliationBalance: NonNegativeMoneySchema.default(0),
  createdDate: IsoDateSchema.optional(),
});

export const ClientAttributionAuditSchema = z.object({
  id: z.uuid(),
  clientId: z.uuid(),
  storeId: z.uuid(),
  managerId: z.uuid(),
  introducedByClientId: z.uuid().optional(),
  date: IsoDateSchema,
  note: z.string().trim().min(1).max(200),
  createdAt: z.date(),
});
```

### 2.2 事后对账审计流水 (`reconciliation.ts`)
```typescript
export const ReconciliationDirectionSchema = z.enum(['ADJUST_IN', 'ADJUST_OUT']);

export const ReconciliationLedgerEntrySchema = z.object({
  id: z.uuid(),
  storeId: z.uuid(),
  managerId: z.uuid(),
  clientId: z.uuid(),
  date: IsoDateSchema,
  direction: ReconciliationDirectionSchema,
  amount: PositiveMoneySchema,
  balanceAfter: NonNegativeMoneySchema,
  note: z.string().trim().min(1).max(200),
  createdAt: z.date(),
});
```

### 2.3 历史凭证领取状态 (`domain.ts` 扩展)
```typescript
export const VoucherStatusSchema = z.enum(['StoredInShop', 'Claimed']);
// OrderSlipSchema 增加:
// voucherStatus: VoucherStatusSchema.default('StoredInShop')
```

---

## 3. 新增后端 API 接口规范

1. **客户建档与归属审计**：
   - `POST /api/clients`：支持传入 `{ storeId?, managerId?, introducedByClientId?, name, date? }`。若传入 `introducedByClientId`，自动继承引荐老客户的 `storeId` 与 `managerId`，并自动生成一条 `ClientAttributionAudit` 记录。
   - `GET /api/hq/attribution-audits`：总部查询客户归属审计列表与按店长/日期汇总的建档统计。
2. **事后对账收支登记与流水查询**：
   - `POST /api/reconciliations`：店长登记客户事后收支调整 `{ managerId, clientId, date, direction: 'ADJUST_IN' | 'ADJUST_OUT', amount, note }`，更新客户 `reconciliationBalance` 并返回新增的 `ReconciliationLedgerEntry`。
   - `GET /api/clients/:clientId/reconciliations`：查询指定客户的对账流水历史。
   - `GET /api/stores/:storeId/reconciliations`：查询指定门店的全部对账流水历史。
3. **历史凭证领取状态更新**：
   - `PATCH /api/orders/:orderId/voucher-status`：店长更新存根的纸质凭证领取状态 `{ voucherStatus: 'StoredInShop' | 'Claimed' }`。
