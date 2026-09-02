# 生产发布、回滚与平台验收手册

适用环境：`yuyue-d0gdy87711d685d64`。

本手册只记录发布所需的命令、配置键、版本号和验证结果。不得写入或复制密钥、令牌、Cookie、openid、连接串、正式业务记录或原始生产日志。生产验证只使用合成隔离数据。

## 1. 固定边界

- 微信小程序、微信云开发和 CloudBase 的网页配置、控制台设置、部署管理与环境管理，必须从 `/Applications/wechatwebdevtools.app/` 内的微信开发者工具入口进入。
- 禁止直接打开腾讯云或 CloudBase 网页控制台执行上述修改；内置入口不可用时停止并记录阻塞，不改走网页入口。
- 公开地址的只读验收可以使用浏览器或命令行，但不得借此修改微信侧配置。
- 不购买标准版，不创建订单，不付款。
- 不推送 Git；发布提交只允许保存在本地。
- `AGENTS.md`、`CLAUDE.md` 不进入发布提交。
- 不读取正式业务数据、正式函数日志、浏览器 Cookie、本地存储或凭据值。
- 上线验证只能使用可识别并可清理的隔离数据。

## 2. 发布停止条件

命中任一项立即停止发布：

- 发布提交没有固定 SHA，或除明确排除文件外仍有未提交的发布改动。
- 测试、语法检查、JSON/YAML 检查、管理后台构建或 `git diff --check` 失败。
- 13 个云函数任一未核对运行时、超时或部署状态。
- 将 `$LATEST` 直接视为不可变回滚点，或切流前没有保留上一正式版本。
- 微信开发者工具内置控制台发生持续网络、TLS、鉴权或加载错误。
- 需要直接网页控制台才能继续配置。
- HTTP 路由、静态托管、匿名登录、最小权限或公开端点验证缺少权威证据。
- 备份恢复、RPO/RTO、告警送达、双平台真机或公众平台材料缺少适用证据。
- 验证需要读取正式记录、正式日志或凭据值。

## 3. 目标与非目标

目标：

- 将 13 个云函数代码部署到批准的运行时。
- 从 `$LATEST` 创建不可变正式版本，并将 100% 流量切到新版本。
- 保留上一正式版本，不删除、不回档。
- 为管理后台配置免费版可用的 HTTP 路由和静态托管。
- 使用隔离数据完成登录、权限、核心流程和清理验证。
- 留下可复核的本地构建、版本、路由和回滚记录。

非目标：

- 购买或升级付费套餐。
- 读取、迁移或修复正式业务数据。
- 上传小程序、覆盖体验版、提交公众平台审核或正式发布小程序。
- 推送远端分支或创建远端发布。

## 4. 本地发布门禁

基准：

```bash
git rev-parse --short HEAD
git status --short
node --version
```

管理后台：

```bash
cd admin-web
npm run build
shasum -a 256 dist/index.html ../cloudfunctions/admin/admin-shell.html
```

仓库检查：

```bash
node --test tests/*.test.cjs
git diff --check
```

还应核对：

- `cloudbaserc.json` 可解析，且函数清单为 13 个。
- 13 个函数的 `package.json` 和锁文件均锁定 `wx-server-sdk` `4.0.2`。
- 云端运行时均为 `Nodejs18.15`，超时与 `cloudbaserc.json` 一致。
- 构建后的 `dist/index.html` 只负责跳转到 `/admin`。
- `cloudfunctions/admin/admin-shell.html` 引用的 JS、CSS 和图片均存在于 `admin-web/dist`。

## 5. 云函数清单

| 函数 | 超时（秒） |
| --- | ---: |
| admin | 30 |
| login | 20 |
| getServices | 20 |
| getAvailableSlots | 20 |
| checkAvailability | 20 |
| createAppointment | 30 |
| cancelAppointment | 20 |
| verifyAppointment | 20 |
| getAppointments | 20 |
| getMyAppointments | 20 |
| getArticles | 20 |
| getArticleDetail | 20 |
| sendReminder | 60 |

所有函数运行时均为 `Nodejs18.15`。

## 6. 云函数正式版本与切流

仅在微信开发者工具内执行：

1. 进入云开发 → 云函数 → 目标函数 → 版本与配置。
2. 从 `$LATEST` 创建新版本，备注格式为 `release-<git-short-sha>-<yyyy-mm-dd>`。
3. 记录新版本号和上一正式版本号。
4. 分配流量：新版本 `100%`，上一版本 `0%`。
5. 保留上一版本，不删除。
6. 使用已审查的只读探针或隔离数据验证。
7. 任何发布失败或控制台网络异常都停止当前批次，不连续盲重试。

回滚条件：新版本健康检查失败、认证授权异常、核心隔离流程失败、静态资源不可用或错误率异常。

回滚步骤：

1. 在微信开发者工具内打开目标函数的流量分配。
2. 将上一正式版本恢复到 `100%`，失败版本设为 `0%`。
3. 不删除失败版本，记录失败原因和时间。
4. 重新运行同一组只读或隔离数据探针。

## 7. 免费版 HTTP 路由目标

路由按最长路径前缀匹配，不使用 `/assets/*`：

| 路径 | 目标 |
| --- | --- |
| `/admin-health` | `SCF/admin` |
| `/admin` | `SCF/admin` |
| `/assets` | `STATIC_STORE/staticstore` |
| `/logo-business.png` | `STATIC_STORE/staticstore` |
| `/` | `STATIC_STORE/staticstore` |

路由必须从微信开发者工具内的云开发入口配置。配置前保存完整路由快照；配置后逐项核对顺序、目标和匹配结果。

## 8. 静态托管发布

1. 在本地完成 `admin-web` 构建。
2. 确认 `dist/index.html` 只跳转到公开 `/admin` 地址。
3. 从微信开发者工具内的云开发入口部署 `admin-web/dist`。
4. 不使用直接网页控制台替代部署。
5. 发布后验证 HTML、JS、CSS、图片和 CDN 更新；保留制品 SHA-256。

## 9. 生产验证

公开只读检查：

- `/admin-health?action=health` 返回 HTTP `200` 和预期 JSON。
- `Strict-Transport-Security` 为 `max-age=31536000`。
- 存在 CSP、`X-Content-Type-Options`、`Referrer-Policy` 和 `Permissions-Policy`。
- `/admin`、`/admin/`、JS、CSS 和图片均可访问。

隔离数据检查：

- 匿名登录可用。
- 管理登录与退出可用。
- 最小权限和拒绝路径符合预期。
- 核心创建、查询、更新和清理流程使用带发布批次标识的隔离数据。
- 验证结束后清理隔离数据并记录清理结果。

不得为了验证读取正式记录、正式日志正文、Cookie、本地存储或凭据值。

## 10. 完整上架门禁

满足免费版安全入口不等于完整具备上架条件。以下项目需要独立权威证据：

- 公众平台主体、名称、简介、类目、隐私保护指引、用户协议、权限用途和审核材料。
- iOS 与 Android 真机安装、登录、权限、网络、弱网和核心流程。
- 实际上传包体及公众平台包体检查。
- 独立账号或独立地域的加密备份，以及在独立恢复环境中的恢复证明。
- 已批准的 RPO/RTO 和实际演练结果。
- 云函数错误告警的真实送达记录。
- 免费套餐生命周期、到期处置和持续运行责任人。

任一适用项缺失时，不得宣称“已完全具备正式上架条件”。

## 11. 2026-08-31 发布批次 `65c0a46`

### 已完成

- 本地分支：`codex/dynamic-branding-admin-crud`；发布基线：`65c0a46`。
- 13/13 云函数代码已通过微信开发者工具上传。
- 13/13 云函数核对为 Active、`Nodejs18.15`，超时与 `cloudbaserc.json` 一致。
- 13/13 云函数依赖锁定 `wx-server-sdk` `4.0.2`。
- `admin` 已创建版本 `10`，备注 `release-65c0a46-2026-08-31-final`；版本 `10` 为 `100%`，版本 `9` 保留为 `0%`。
- `verifyAppointment` 已创建版本 `2`，备注 `release-65c0a46-2026-08-31`；版本 `2` 为 `100%`，版本 `1` 保留为 `0%`。
- 管理后台已在 Node.js `v26.3.0` 上重新构建成功。
- 构建后 `dist/index.html` SHA-256：`c0a3a5eb7aa702e3703e2a9aa2c77ca0a8441659d7dac2ac5553d44cca1b8ac8`。
- 构建后 `cloudfunctions/admin/admin-shell.html` SHA-256：`65696524ff1d0a6c20fb9bb43e356f37202bbcb3d9a6842b5c0b2bde2d7cff54`。
- 未购买套餐、未创建订单、未付款、未推送 Git、未读取正式业务数据。
- 已接受限时的 5 个高危和 1 个中危上游依赖风险。

### 未完成或阻塞

- `sendReminder` 创建新版本时，微信开发者工具内置控制台两次出现 `Client network socket disconnected before secure TLS connection was established`；新版本未创建，现有版本与流量未改动。
- `login`、`getServices`、`getAvailableSlots`、`checkAvailability`、`createAppointment`、`cancelAppointment`、`getAppointments`、`getMyAppointments`、`getArticles`、`getArticleDetail` 尚未创建本批次不可变版本并切流。
- `admin` 版本 `10` 切流后的公开健康检查尚未获得权威响应证据。终端 TLS 建连失败；应用内浏览器被 CloudBase 测试域名提示页和客户端导航阻断。
- 免费版 HTTP 路由尚未完成配置。
- 本批次 `admin-web/dist` 尚未部署到静态托管。
- `/admin`、`/admin/`、JS、CSS、图片、匿名登录、安全响应头和隔离数据流程尚未完成本批次生产验证。
- 独立备份恢复、RPO/RTO、告警送达、双平台真机、实际包体和公众平台材料仍缺少权威证据。

### 当前结论

本批次尚不具备完整正式上架条件。允许继续本地收口，但在微信开发者工具内置云开发控制台恢复稳定、剩余函数版本与流量完成、路由与静态托管完成并取得生产验证证据前，不提交正式审核。
