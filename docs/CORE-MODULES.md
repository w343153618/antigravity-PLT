# 核心契约与结算模块

本次实现范围为 `SPEC.md` 第 2、3 节以及 `CONTEXT.md` 中对应的不变式。领域命名以 `CONTEXT.md` 为准。

## 使用与验证

运行环境为 Node.js 26 或更高版本，依赖通过根目录 `package-lock.json` 锁定。

```sh
npm ci
npm run typecheck
npm test
npm run test:coverage
```

源码的相对导入使用 `.ts` 扩展名，可由 Node.js 26 原生执行，无需生成 JavaScript 文件。在项目根目录执行以下命令验证运行时入口：

```sh
node --input-type=module -e 'import { calculateSettlement } from "./src/modules/settlement/index.ts"; console.log(calculateSettlement({ totalAmount: 2, payoutPerUnit: 1040, quantity: 1, isHit: true, adoptedStrategy: true }));'
```

Vitest 只运行根目录 `tests/**/*.test.ts`。第二阶段已将覆盖率统计扩展至 `src/**/*.ts`（排除启动进程入口 `src/app/server.ts`）；业务模块及共享契约的语句、分支、函数、行覆盖率门槛均保持 100%。整体门槛为语句 95%、分支 90%、函数 100%、行 95%。浏览器 JavaScript 通过页面验收验证，不包含在该覆盖率统计中。HTML 报告生成在 `coverage/index.html`。

## 公开边界

- `src/shared/schemas/index.ts`：导出 Zod 契约及由契约推导的 TypeScript 类型。
- `src/modules/settlement/index.ts`：导出纯函数 `calculateSettlement`、`SettlementInput` 和 `SettlementResult`。

`ThreeDigitCode` 保留前导零，只接受恰好三位 ASCII 数字字符串。`StrategyPortfolio` 必须包含三组组合，权重在 1～100 范围内；权重不要求相加为 100，也不额外禁止重复标的。日期须为有效的 `YYYY-MM-DD` 日历日期，`createdAt` 须为有效 `Date` 实例。

`OrderSlip` 保留 SPEC 中 `adoptedStrategy = true` 的录入默认值；解析后的 `OrderSlip` 类型始终含有该字段，解析前的 `OrderSlipInput` 允许省略。`OutcomeStatus` 只允许 `Hit` 和 `Miss`。对象契约拒绝未知字段，数字和布尔字段不作字符串强制转换。

## 结算口径

```typescript
import { calculateSettlement } from '../src/modules/settlement/index.ts';

const result = calculateSettlement({
  totalAmount: 2,
  payoutPerUnit: 1040,
  quantity: 1,
  isHit: true,
  adoptedStrategy: true,
});
// { grossGain: 1040, netGain: 1038, performanceFee: 207.6,
//   managerIncentive: 103.8, platformMargin: 103.8 }
```

这里的单组产出为调用参数，模块未固定任何品类的基准产出。

1. 结算入口要求显式传入 `adoptedStrategy`。这是对 SPEC 示例函数签名的补充，用于落实 CONTEXT 中“采纳策略且实现正向收益才结算服务费”的约束。未采纳时仍返回总产出与净收益，三项服务分成为 0。
2. `netGain` 遵循 SPEC 示例实现，为 `max(0, grossGain - totalAmount)`；未命中时总产出与净收益均为 0。SPEC 的字段注释允许负数，但示例代码将其截断，因此本模块不返回负数。原始投入仍由 `OrderSlip.totalAmount` 保存。
3. 输入金额须为正数且最多两位小数；数量须为正的安全整数。内部采用 `bigint` 分单位运算，服务费按净收益的 20%、店长激励按 10% 四舍五入至分，平台留存为两者之差。例如净收益 0.35 时，服务费 0.07、店长激励 0.04、平台留存 0.03。
4. 分润恒等式在整数分单位成立。由于对外类型为 JavaScript `number`，调用方核对金额时应转为分后比较，不能依赖浮点加法的严格相等。分单位超过安全整数范围，或计算结果无法以 `number` 保留每一分时，抛出 `RangeError`；输入契约不合法时抛出 Zod 校验错误。
5. `calculateSettlement` 只使用传入的数据计算，不修改输入、不读写文件、不发起网络请求。`isHit` 是调用方已核验的结果；订单所属客户、日期匹配、重复结算和日汇总由后续业务编排层处理。

## 实施流程记录

已读取 Matt Pocock v1.3.1 `implement-spec`、`tdd` 和 `code-review` 技能，按用户明确指定的契约与函数边界逐步执行失败测试 → 最小实现 → 通过测试，并进行规范和规格两项独立审查。

核心模块实施时，项目根目录没有 Git 元数据或工单跟踪配置，因此采用本地文件协作，未创建集成分支、worktree、提交或 PR。

2026-10-13 已完成 `/setup-matt-pocock-skills` 配置，工单使用 `w343153618/pai-lie-3` 的 GitHub Issues，规则见 `docs/agents/issue-tracker.md`。根目录仍未初始化 Git；执行集成分支、worktree 或 PR 交付前，须先核实并建立对应的本地 Git 工作区与远程关联。
