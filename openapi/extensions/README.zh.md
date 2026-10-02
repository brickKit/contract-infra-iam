[English](README.md) · [中文](README.zh.md)

# 成员专属扩展

某个成员为自己的 IdP 提供、其他成员没有的路径：webhook 桥接、轮询钩子。它们属于该成员的实现，列在这里只是为了让族内路径不冲突。

| 规则 | |
|---|---|
| 前缀 | IdP 回调用 `/api/iam/webhooks/<成员短名>`；其它一律 `/_iam/<成员短名>/…` |
| 边缘 | 永远不是边缘路由；IdP 在项目网络里按成员自己的服务名访问 |
| 调用方 | 只有该成员的 IdP；组件和前端都不调用 |
| 认证 | 共享密钥或 IdP 支持的签名，常量时间比较；不用平台 token |
| 效果 | 只经族契约的面体现：webhook 让成员回读 IdP 再发 `infra.iam.*` 事件，响应里不带目录数据 |
| 一致性测试 | `iamconf` 不覆盖；各成员自己测自己的扩展 |

| 成员 | 文件 | 路径 |
|---|---|---|
| `infra/iam-casdoor` | [infra-iam-casdoor.openapi.yaml](infra-iam-casdoor.openapi.yaml) | `POST /api/iam/webhooks/casdoor` |
| `infra/iam-keycloak`（计划中） | — | 无：轮询 Keycloak 的 admin events |
| 通用 OIDC + SCIM 成员（计划中） | — | 无：SCIM 入站是族能力（`scim_inbound`） |
