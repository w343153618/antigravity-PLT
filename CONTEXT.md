# CONTEXT: 连锁门店档案归属与事后对账管理 ERP (store-records-erp)

本项目严格遵循 Matt Pocock (v1.3.1) 的 `domain-modeling` 规范建立。  
本文档为全系统的**唯一领域事实来源（Single Source of Truth）**，定义系统核心概念、边界与不可变业务规则（Invariants）。

---

## 1. 统一领域术语表 (Glossary)

| 术语 (Canonical Term) | 对应概念 | 详细定义与职责 |
| :--- | :--- | :--- |
| **`Store` (实体网点)** | 实体经营网点 | 具有独立地理辐射范围的线下实体门店。 |
| **`StoreManager` (店长)** | 网点经营者 | 负责实体网点日常运营，维护本店客户档案，登记已在线下完成的业务与往来收支对账。 |
| **`Client` (客户档案)** | 门店归属客户 | 挂靠在特定实体网点与店长名下的客户档案，可查阅自身历史对账流水与纸质凭证保管状态。 |
| **`AttributionRecord` (归属关系与审计)**| 档案归属与引荐来源 | 记录客户档案建立时的归属关系。不论由店长直接建档还是由老客户引荐建档，新客户档案均归属到源头店长所在的 `Store`，并保留归属与引荐审计记录。 |
| **`ReconciliationBalance` (往来对账结余)**| 事后对账核算余额 | 仅用于事后记录已在线下实际发生的收支往来结余（精确到分），不构成预付资金池，不用于发起在线交易指令。 |
| **`ReconciliationLedgerEntry` (对账审计流水)**| 追加式收支对账流水 | 登记线下已发生的收支增减、调整原因、操作人（店长）和时间戳的不可篡改追加式审计流水。 |
| **`StrategyPortfolio` (策略包)**| 每日量化组合 | 总部每日发布的 3 套独立的 3-Digit 标的组合方案（值域 000~999），附带推荐权重，仅供历史比对参考。 |
| **`ResolutionEvent` (决议事件)** | 官方结果对齐 | 每日由官方公布的基准 3 位数字结果，用于触发历史存根对账与战绩核验。 |
| **`OutcomeStatus` (战绩状态)** | 红黑榜状态 | 针对某一历史日期的策略核验结果：<br>• **`Hit` (红)**：命中基准标的，高亮红色显示；<br>• **`Miss` (黑)**：未达成目标，深色/黑色显示。 |
| **`OrderSlip` (历史业务存根)** | 已完成线下业务记录 | 店长事后登记的已在线下完成的业务存根，含纸质凭证领取状态（`StoredInShop` 店内存管待领 / `Claimed` 客户已到店领取），不生成任何外部操作。 |
| **`PerformanceFee` (增值服务费)**| 盈利技术分成 | 仅在采纳策略且实现正向净收益时核算的技术咨询服务费，基准比例为 **净收益的 20%**。 |
| **`ManagerIncentive` (店长激励)**| 门店拓展激励 | 从 20% 增值服务费中拆出归属店长的部分，基准为 **净收益的 10%**（即服务费的 50%）。 |
| **`PlatformMargin` (平台留存)** | 平台技术留存 | 从 20% 增值服务费中留存归属总部的部分，基准为 **净收益的 10%**（即服务费的 50%）。 |
| **`AttributionSummary` (归属汇总统计)**| 总部档案与审计统计 | 按日期与店长维度汇总客户建档数量、引荐来源统计及归属变更审计。 |

---

## 2. 核心业务不变式 (Invariants / Business Rules)

任何代码修改、功能新增或重构，均**不得违反**以下不变式约束：

1. **纯事后对账与非交易指令不变式（Post-Facto Reconciliation Only）**：
   * 系统仅用于**已完成线下业务的事后登记与对账**，严禁生成任何线上未授权外部调用。
   * 店长登记收支调整（`ADJUST_IN` 收款登记 / `ADJUST_OUT` 支用或核减登记）时，必须记录调整原因（`note`）、操作人（`managerId`）与时间，采用追加式审计流水（`ReconciliationLedgerEntry`），精确到分。
2. **纸质凭证领取状态管理（Voucher Custody Status）**：
   * 已在线下完成的业务存根（`OrderSlip`）维护纸质凭证保管状态：`StoredInShop`（纸质凭证店内存管待取）与 `Claimed`（客户已到店领取紙质原件），方便下雨天未取凭证的客户事后查询并在晴天到店领取。
3. **客户档案传递归属与审计不变式（Transitive Client Attribution）**：
   * 客户档案建立时支持记录引荐来源：若由店长 $M$ 直接建档，归属 $(S, M)$；若由店长 $M$ 名下的老客户 $A$ 引荐建档，新客户 $B$ 自动继承归属 $(S, M)$ 并记录 `introducedByClientId = A`，同时写入归属审计日志。
4. **单应用三角色视图不变式（Three-Role Perspective）**：
   * **客户视图 (`Client`)**：只读查阅自身历史凭证存根（含是否已到店领取）、自身往来对账流水、以及 30 天红黑历史参考。
   * **店长视图 (`Manager`)**：管理本店客户档案与引荐归属、登记已完成线下业务存根、更新纸质凭证领取状态（`StoredInShop` ➔ `Claimed`）、登记事后收支调整流水。
   * **总部视图 (`HQ Admin`)**：查询各门店/店长的客户归属汇总、按日建档统计、全量对账审计记录，以及发布策略和录入决议结果。
5. **分润对账恒等式（Settlement Equation）**：
   * $\text{PerformanceFee} = \text{NetYield} \times 20\%$
   * $\text{ManagerIncentive} = \text{NetYield} \times 10\%$
   * $\text{PlatformMargin} = \text{NetYield} \times 10\%$
   * 约束：$\text{ManagerIncentive} + \text{PlatformMargin} \equiv \text{PerformanceFee}$
