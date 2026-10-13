# 0002. 三角色权限视图、客户归属审计与事后对账流水架构决策 (ADR)

- **状态 (Status)**: 已批准 (Approved)
- **遵循标准**: Matt Pocock (v1.3.1) Architecture Decision Record Standard
- **上下文**: 第三阶段功能演进（客户档案与归属审计、已完成线下业务事后对账、历史凭证领取状态查询、三角色视图）

---

## 背景 (Context)
系统定位严格限定为“已完成线下业务的事后对账与档案管理工具”，不生成任何线上外部操作。核心演进范围包括：
1. **客户档案与归属管理**：维护门店、店长、客户关系，支持老客户引荐归属继承（新客户自动归属原店长所在门店），记录归属变更与建档审计。
2. **已完成线下业务的事后对账**：登记实际发生的收支（`ADJUST_IN` / `ADJUST_OUT`）、调整原因、操作人和时间，采用精确到分的计算与追加式审计流水。
3. **历史凭证查询**：记录已在线下完成的业务及纸质凭证领取状态（`StoredInShop` 店内存管待领 ➔ `Claimed` 已到店领取），不生成外部操作。
4. **三角色界面与权限**：客户查看自己的历史记录与对账明细，店长管理本店档案、对账与凭证领取状态，总部查询汇总与审计记录。

---

## 架构决策 (Decisions)

1. **三角色单页视图架构 (Three-Role View Architecture)**:
   * 在同一前端界面提供【客户视图（只读查询自身记录）】、【店长视图（本店档案、事后对账与存根登记）】、【总部视图（全局汇总与审计查询）】。
2. **传递式档案归属与审计日志 (Transitive Client Attribution & Audit Log)**:
   * 建档时可指定店长直接归属，或指定老客户作为引荐人（`introducedByClientId`）。指定老客户引荐时，系统自动继承该老客户所属的 `storeId` 与 `managerId`，并写入 `client_attribution_audit` 审计表。
3. **精确到分的追加式事后对账流水 (Append-Only Reconciliation Ledger)**:
   * 店长登记线下实际发生的收支调整（`ADJUST_IN` 增加结余 / `ADJUST_OUT` 核减结余），使用 `BigInt` 分单位计算，必填调整原因（`note`）与操作店长（`managerId`），写入不可篡改的 `reconciliation_ledger` 表。
4. **纸质凭证保管状态 (Paper Voucher Custody State)**:
   * `OrderSlip` 维护 `voucherStatus: 'StoredInShop' | 'Claimed'`（默认 `'StoredInShop'` 店内存管待领，客户晴天到店取走后由店长标记为 `'Claimed'`）。
