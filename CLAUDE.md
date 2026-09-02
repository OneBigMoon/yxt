# 中医门诊预约小程序

## 项目概述

微信小程序 + 云开发项目，包含患者预约、技师核销、管理后台三个端。

## 架构

- **小程序端**：`miniprogram/`，用 `wx.cloud.callFunction` 调用云函数
- **管理后台 H5**：`admin-web/`，用 `@cloudbase/js-sdk` 的 `app.callFunction` 调用云函数
- **云函数**：`cloudfunctions/`，统一通过 `admin` 云函数的 action 路由处理管理后台请求
- **云环境 ID**：`yuyue-d0gdy87711d685d64`

## 开发命令

```bash
# 管理后台本地开发
cd admin-web && npm run dev

# 管理后台打包
cd admin-web && npm run build

# 管理后台部署到云开发静态托管
cd admin-web && tcb hosting deploy ./dist -e yuyue-d0gdy87711d685d64
```

## 部署要点

- 管理后台部署到微信云开发静态网站托管，用 `@cloudbase/js-sdk` 直接调云函数，不需要 Express 服务器
- 部署前需在云开发控制台开启匿名登录（设置 → 登录授权）
- 静态托管地址：`https://yuyue-d0gdy87711d685d64-1373613778.tcloudbaseapp.com`
- CDN 缓存可能有延迟，部署后用无痕模式验证

## 云函数列表

login、getServices、getAvailableSlots、createAppointment、cancelAppointment、verifyAppointment、getAppointments、getMyAppointments、getArticles、getArticleDetail、sendReminder、admin

## 数据库集合

users、services、technicians、appointments、business_config、holidays、tech_days_off、articles、commission_records、admin_users、login_sessions、admin_sessions

## 注意事项

- 管理后台 H5 端没有微信用户态，通过匿名登录调用云函数
- 管理后台使用密码或微信扫码登录，扫码登录需先把微信 openid 加入 `admin_users`
- 路由使用 Hash 模式（`createWebHashHistory`），静态托管刷新不会 404
