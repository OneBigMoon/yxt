# 预约服务小程序

微信小程序与云开发项目，包含用户预约、工作人员核销和管理后台三个端。

## 项目结构

- `miniprogram/`：微信小程序，通过 `wx.cloud.callFunction` 调用云函数。
- `admin-web/`：Vue 3 管理后台，通过 `@cloudbase/js-sdk` 调用 `admin` 云函数。
- `cloudfunctions/`：云函数源码。
- `tests/`：发布安全与前端契约测试。
- `TEST_CHECKLIST.md`：发布前人工验收与外部平台核对清单。
- `docs/release/production-release-runbook.md`：生产发布、回滚、恢复演练和平台验收步骤。

## 固定环境

- 小程序 AppID：以 `project.config.json` 为准。
- 云环境 ID：`yuyue-d0gdy87711d685d64`。
- 管理后台静态托管：`https://yuyue-d0gdy87711d685d64-1373613778.tcloudbaseapp.com`。
- 云函数运行时：`Nodejs18.15`。现有函数的运行环境不能原地修改；如需迁移到 `Nodejs20.19`，必须新建函数并切换调用方，或另行明确授权删除重建。

生产凭据、AppSecret、会话令牌和管理员密码不得写入仓库或前端代码。

## 本地开发与验证

```bash
cd admin-web
npm ci
npm run dev
```

管理后台构建环境要求 Node.js `>=20.19.0`。

```bash
cd admin-web
npm run build
```

```bash
node --test tests/*.test.cjs
```

小程序依赖在 `miniprogram/` 执行 `npm ci`，随后在微信开发者工具中执行“构建 npm”和编译。

## 云函数

根目录 `cloudbaserc.json` 是发布清单，当前包含：

- `admin`
- `login`
- `getServices`
- `getAvailableSlots`
- `checkAvailability`
- `createAppointment`
- `cancelAppointment`
- `verifyAppointment`
- `getAppointments`
- `getMyAppointments`
- `getArticles`
- `getArticleDetail`
- `sendReminder`

节假日导入由 `admin` 云函数的 `importHolidays` action 处理，不是独立发布函数。

13 个云函数均精确锁定 `wx-server-sdk 4.0.2`。禁止使用 `.watch()`、`requestClient`、动态 `cloud.openapi[...]`、自定义 `serviceUrl`/代理或将请求对象整体写入数据库。该版本仍有 5 个高危和 1 个中危上游风险，本次仅在当前调用图不可达且补偿控制保持有效的前提下限时接受至 2026-11-28，不表示漏洞已修复。

## 数据库集合

- `users`
- `services`
- `technicians`
- `appointments`
- `business_config`
- `business_config_versions`
- `holidays`
- `tech_days_off`
- `articles`
- `commission_records`
- `admin_users`
- `login_sessions`
- `admin_sessions`
- `admin_audit_logs`

管理员登录限流状态保存在 `admin_users`；预约互斥锁以专用文档保存在 `login_sessions`，无需额外集合。

发布前必须在目标云环境建立 `TEST_CHECKLIST.md` 中的固定复合索引，并保持默认单字段索引启用。后台动态筛选组合需按实际请求逐项验证，依据 CloudBase 索引提示补齐后复测分页。

## 管理后台

管理后台使用 Hash 路由，可部署到云开发静态网站托管：

```bash
cd admin-web
npm ci
npm run build
tcb hosting deploy ./dist -e yuyue-d0gdy87711d685d64
```

云开发控制台必须开启匿名登录，并将实际后台域名加入 Web 安全域名。

生产环境应绑定自有 HTTPS 域名，并通过 CloudBase HTTP 网关配置浏览器安全响应头。至少验证以下策略实际生效：

- `Content-Security-Policy` 使用经登录、扫码和云函数调用实测的最小域名白名单，并限制页面嵌入。
- `Strict-Transport-Security` 仅在自有域名及其需要覆盖的子域均已完成 HTTPS 后启用。
- `X-Content-Type-Options: nosniff`、严格的 `Referrer-Policy` 和仅开放实际所需能力的 `Permissions-Policy`。
- HTML 保持短缓存，带内容哈希的 JS/CSS 使用一年长缓存；部署后刷新 CDN，并确认线上资源哈希与本次构建一致。

扫码登录需要在 `admin` 云函数安全配置中提供微信 AppID、AppSecret 和小程序码环境版本。测试版使用 `trial`，正式版使用 `release`。这些值只配置在云端，不写入仓库；缺少 AppID 或 AppSecret 时，管理后台只保留账号密码登录，并禁止创建失败的扫码会话。

四个订阅消息模板 ID 应分别配置到 `createAppointment`、`cancelAppointment`、`verifyAppointment`、`sendReminder`，并同步配置到 `admin` 供小程序读取授权列表。小程序在确认预约时申请创建、取消和提醒通知，在“查看预约”按钮上申请完成通知；拒绝或接口失败不得阻断预约主流程。

## 生产发布顺序

1. 通过云开发控制台预置至少一个已启用的 `super_admin`；代码不提供首次管理员自动创建路径，并应删除历史 `ADMIN_BOOTSTRAP_USERNAME`、`ADMIN_BOOTSTRAP_PASSWORD` 环境变量。
2. 创建集合和索引，确认匿名登录、调用权限、合法域名及订阅消息权限；在云函数安全规则中合并 `"sendReminder": { "invoke": false }`，禁止小程序和 Web 客户端直接调用定时提醒函数。
3. 先部署预约相关云函数，并用隔离数据验证创建、取消、查询和核销。
4. 部署其余云函数，记录部署时间、版本和上一可回滚版本。
5. 构建并部署管理后台，使用无痕窗口完成生产冒烟。
6. 在微信开发者工具中编译、预览并完成真机关键流程。
7. 完成公众平台隐私指引、用户协议、权限声明、名称简介、服务类目和主体资料。
8. 按 `TEST_CHECKLIST.md` 留存完整证据后再上传并提交审核。

未经明确授权，不读取或写入生产业务数据，不部署、不上传版本、不提交审核。
