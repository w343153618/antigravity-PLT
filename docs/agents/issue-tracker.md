# Issue tracker: GitHub

本项目的工单和后续功能规格记录在 GitHub Issues。
目标仓库固定为 `w343153618/pai-lie-3`，使用 gh CLI 操作。

## 仓库定位

所有 gh issue、gh pr 和 gh label 命令均显式指定：
`--repo w343153618/pai-lie-3`。

当前项目根目录尚未初始化 Git。工单配置不代表本地代码
已经关联远程、提交或推送。分支和 worktree 操作前，
必须核实实际 Git 根目录及远程仓库。

## 基本操作

- 创建工单：
  `gh issue create --repo w343153618/pai-lie-3 --title "<标题>" --body-file "<正文文件>"`
- 读取工单：
  `gh issue view <编号> --repo w343153618/pai-lie-3 --json number,title,body,labels,comments`
- 列出工单：
  `gh issue list --repo w343153618/pai-lie-3 --state open --json number,title,labels,assignees`
- 添加评论：
  `gh issue comment <编号> --repo w343153618/pai-lie-3 --body-file "<正文文件>"`
- 添加或移除标签：
  `gh issue edit <编号> --repo w343153618/pai-lie-3 --add-label "<标签>"`
  或使用 `--remove-label`。
- 关闭工单：
  `gh issue close <编号> --repo w343153618/pai-lie-3`

多行正文先写入 UTF-8 文件，再通过 --body-file 传入。

## 规格与实施工单

现有 `SPEC.md` 和 `CONTEXT.md` 保留各自职责。
新功能发布到工单系统时，创建规格工单，并引用相关领域文档。

每个实施任务单独建立工单，包含范围、验收条件和依赖。
优先使用 GitHub 子工单及原生依赖关系；不可用时，
在正文中使用 `Part of #<父工单>` 和 `Blocked by: #<依赖>`，
并在父工单维护任务清单。

只有依赖已关闭、尚未被认领的任务可以进入实施。
认领时分配给执行者；完成验收后记录验证证据并关闭工单。
通过 PR 交付时，在 PR 正文关联对应工单。

## Pull requests as a triage surface

PRs as a request surface: no.

## Wayfinding

地图使用一个带 `wayfinder:map` 标签的工单，
正文包含 Notes、Decisions-so-far 和 Fog。

每个子任务建立独立子工单，类型标签使用：
`wayfinder:research`、`wayfinder:prototype`、
`wayfinder:grilling` 或 `wayfinder:task`。

按地图中的顺序选择未关闭、依赖已完成且未认领的子工单。
认领时设置 assignee；解决后记录答案、关闭子工单，
并向地图的 Decisions-so-far 添加结论和链接。
