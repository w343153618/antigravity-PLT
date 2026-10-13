# 门店档案与事后对账工作台

Node.js / TypeScript / SQLite 独立实现。用于客户归属档案、已完成线下业务的事后对账及纸质凭证领取管理。完整领域定义见 [CONTEXT.md](CONTEXT.md)，实现范围见 [SPEC.md](SPEC.md)。

## 运行

需要 Node.js 26+：

```sh
cd records-erp
npm ci
npm start
```

打开 http://127.0.0.1:19888 。默认数据库为 `data/app.db`，首次空库载入明确标记的合成演示数据。`npm run dev` 启用源码监听。

账号：`user`（客户）、`dianzhang`（店长）、`admin`（总部）。预置初始口令沿用本次用户指定值，不在仓库文档公布。新部署可在首次启动前通过 `AUTH_BOOTSTRAP_PASSWORD` 指定初始化口令；已有账号不会被覆盖。详细绑定、权限、会话及空库初始化流程见 [独立登录说明](docs/AUTHENTICATION.md)。

```sh
npm run typecheck
npm test
npm run test:coverage
```

2026-10-13 本轮验证：16 个测试文件、208 项测试通过，类型检查及原有覆盖率门槛全部通过。三角色、调账交互与手机布局验收见 [本轮验收记录](docs/qa/hardening/README.md)；改动范围见 [隔离与迁移加固说明](docs/HARDENING.md)。

## 单目录 Docker Compose 启动与迁移

本目录可独立复制到新服务器，安装 Docker Engine 与 Compose v2 后执行：

```sh
sh scripts/start.sh
```

默认仅在 `127.0.0.1:19888` 提供服务，关闭合成数据初始化。首次自动创建 `.env`，可按 [.env.example](.env.example) 设置端口、HTTPS Cookie 与初始化口令。空库先启用总部账号；门店、店长和客户身份的分阶段建立流程见 [认证说明](docs/AUTHENTICATION.md)。如需预置三账号的合成演示，请在首次启动前设置 `DEMO_SEED=true`。

一致快照与恢复分别执行 `sh scripts/backup.sh`、`sh scripts/restore.sh <备份文件名>`。完整迁移、权限、代理与真实 Docker 验证见 [部署说明](docs/DEPLOYMENT.md)。

## 数据与运行范围

业务数据、账号摘要和绑定均在 SQLite 中；会话在单进程内存中，服务重启后需重新登录。网站静态资源及 Vue 运行时由本服务托管，无需外部 CDN。全新演示数据仅用于体验，不代表真实收支或官方数据。

`PORT` 默认 19888、`HOST` 默认 127.0.0.1；`DATABASE_PATH` 指定数据库位置；`DEMO_SEED=false` 禁止生成演示资料。HTTPS 访问应设置 `COOKIE_SECURE=true`。默认固定账号是本次初始化交付，正式多用户运行还需要账号生命周期管理和明确身份绑定。

备份时先停止服务，再将整个 `data/` 目录打包；恢复到相同版本应用的 `data/` 目录后重新启动。SQLite 使用 WAL，运行中不能仅复制 `app.db`；停止服务后打包目录可包含同目录全部必要文件。备份包含客户资料和密码摘要，应作为敏感数据保管。

本目录是新增 Node 应用，不替换仓库根目录已有的 Python 账本，也不改变它的部署。根目录 `android/` 继续服务已有 Python 后端；本次 Android 修改仅为 FLAG_SECURE。
