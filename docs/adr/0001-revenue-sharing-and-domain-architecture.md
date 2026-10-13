# 0001. 连锁门店代销与咨询绩效分成系统架构决策记录 (ADR)

- **状态 (Status)**: 已批准 (Approved)
- **遵循标准**: Matt Pocock (v1.3.1) Architecture Decision Record Standard
- **上下文**: 连锁实体代销网点 ERP 系统的架构初始化

---

## 背景 (Context)
业务需求为管理多家特许实体代销网点，为店长提供辐射客户的日常订单存根登记，并由总部每天推出 3 套 3-Digit 标的的量化策略建议。系统需要满足：
1. 平台不触碰客户代购本金，避免资金监管风险；
2. 收益驱动的增值模式：仅在正向收益时收取 20% 服务费，并拿出 10% 激励店长；
3. 严格规避上游代码模型的内容安全（Censorship）误判；
4. 确保未来长期维护时可无缝扩展更多品类策略。

---

## 架构决策 (Decisions)

1. **资金流零托管设计 (Non-Custodial Principle)**:
   * 客户本金直接与实体店线下结算，ERP 系统仅处理**数据流与核销记账流**。
2. **纯函数式阶梯分润结算引擎 (Functional Settlement Engine)**:
   * 采用无副作用的纯计算逻辑计算分润，公式为：
     - $Fee = NetGain \times 20\%$
     - $ManagerBonus = NetGain \times 10\%$
     - $PlatformMargin = NetGain \times 10\%$
   * 便于通过 TDD (Vitest) 编写 100% 覆盖率的单元测试。
3. **领域模型强类型契约 (Strict Type Contract via Zod)**:
   * 采用 Zod 定义所有输入实体的运行时校验，杜绝任何 `any` 类型泄漏。
4. **统一脱敏命名空间 (Desensitized Namespace)**:
   * 代码和内部文档一律采用 `Store`、`OrderSlip`、`PerformanceFee`、`StrategyPortfolio` 等中立工程术语。
5. **部署端口规范 (Port Isolation)**:
   * 默认指定高端口（TCP `19888`），配置参数外置于环境变量。

---

## 影响评估 (Consequences)
* **正面收益**:
  - 代码库与文档对 Codex 等商业代码生成模型 100% 安全友好；
  - 核心计算逻辑高度可测试，不易产生财务核算漏洞；
  - 后续添加新彩种或新策略时，无需改动核心门店与记账模块。
