---
name: 策略与门店
description: 手机柜台与桌面门店工作台
colors:
  paper: "#ffffff"
  canvas: "#f2f5f5"
  text: "#19332f"
  muted: "#60716d"
  primary: "#176458"
  primary-hover: "#105246"
  primary-soft: "#e5efeb"
  line: "#dce4e1"
  hit: "#ca3442"
  miss: "#253430"
typography:
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "15px"
    lineHeight: 1.6
  headline:
    fontSize: "1.85rem"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "-0.03em"
  title:
    fontSize: "1.15rem"
    fontWeight: 650
    lineHeight: 1.4
  label:
    fontSize: "0.8rem"
    fontWeight: 500
  mobile-field:
    fontSize: "16px"
rounded:
  button: "8px"
  field: "7px"
  table: "12px"
  surface: "14px"
spacing:
  compact: "8px"
  control: "16px"
  section: "24px"
  page: "40px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.paper}"
    rounded: "{rounded.button}"
    padding: "9px 16px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-secondary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.text}"
    rounded: "{rounded.button}"
    padding: "9px 16px"
  field:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.text}"
    rounded: "{rounded.field}"
    padding: "10px 12px"
  surface:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.surface}"
---

# Design System: 策略与门店

## Overview

**Creative North Star: "线下经营，线上留档。"**

沿用既有门店账本的纸白、冷灰、松绿与系统中文字体，服务手机柜台录入和桌面记录对照。以清晰字段、紧凑数据和明确状态组织操作。当前实现依据为 `src/app/client/styles.css`、`index.html` 与 `app.js`。

**Key Characteristics:**

- 纸白业务面板与冷灰底色。
- 松绿用于主要动作和当前入口。
- 核验状态同时使用颜色与文字。

## Colors

### Primary

松绿用于登记按钮、当前导航和可操作文字；深松绿用于主要按钮悬停，浅松绿用于选中导航与已核算标签。

### Neutral

纸白承载表单和记录；冷灰划分页面背景；深正文色用于主要信息，次级色用于说明与占位文字，边线分隔连续内容。

核验色另有固定含义：鲜红为 Hit，深色为 Miss，灰色表示等待核验。

**The 状态双通道 Rule.** 核验状态同时显示红 / Hit、黑 / Miss 或待核验文字。

## Typography

全界面使用同一系统中文无衬线字体栈。正文基准与标题参数见前置 tokens；移动端一级标题为 1.6rem，二级标题通常为 1.06rem。金额与标的数字使用 `tabular-nums`，三位标的保留前导零。金额右对齐，客户和记录信息左对齐。

**The 移动表单 Rule.** 760px 及以下的输入框、选择框均为 16px，包含顶部门店切换。

## Layout

主内容最大宽度 1280px。桌面左栏为 228px，1100px 及以下收窄为 190px；760px 及以下改为 66px 高的底部导航并叠加安全区。内容横向留白从 40px 经 28px 缩至手机的 20px；359px 及以下为 14px。

策略面板桌面三列、手机纵向排列；日历保持七列。记录表格保留双向滚动和全部记录，桌面最大高度 26rem，手机为 24rem，表头吸顶。工作台顶部提供打开并跳转到数据管理区的快捷入口。

## Elevation & Depth

普通面板以背景和单像素边线区分层次。抽屉使用向上的柔和阴影（`0 -10px 45px rgba(20,45,30,.16)`），提示消息使用下落阴影（`0 6px 22px rgba(10,30,20,.16)`）。抽屉遮罩为半透明深色。

## Shapes

按钮、字段、表格与面板圆角见 tokens。状态标签为 5px 圆角，抽屉仅顶部使用 18px 圆角。图标使用同一组描边 SVG，线宽 1.7，圆形端点与连接。

## Components

- **按钮：** 主要按钮用松绿与白字；普通按钮为纸白与细边线；文字按钮无底色。标准按钮最小高度 44px，文字和提示区紧凑按钮另有 36–40px 实现。禁用状态降低透明度并阻止提交。
- **字段：** 纸白底、细边线、占位文字使用次级正文色。聚焦使用 3px 琥珀色外轮廓并偏移 3px。
- **导航：** 桌面左侧横向图文条目，手机底部纵向图文入口；当前入口为松绿，桌面额外使用浅松绿背景。
- **状态标签与日历：** 红、黑、灰对应已命中、未命中、待核验；日期按钮打开逐项数字比对详情。
- **抽屉：** 使用原生 `dialog`，最大宽度 600px，桌面最大高度 90dvh、手机 92dvh；键盘焦点由原生模态行为约束。保存中阻止关闭登记抽屉。出现时使用 180ms 过渡，减少动态效果偏好下禁用动画与过渡。
- **数据管理：** 使用可展开区域承载低频操作。失败保留表单内容，成功通过状态提示反馈。

## Do's and Don'ts

### Do:

- **Do** 保留前导零、金额对齐和明确的状态文字。
- **Do** 保留移动端 16px 表单字号和可见键盘焦点。
- **Do** 让长表格在自身区域滚动，并保持数据管理入口可达。

### Don't:

- **Don't** 只用颜色表达核验状态。
- **Don't** 将待核验显示为已核验结果。
- **Don't** 将演示门店切换呈现为真实身份认证。
