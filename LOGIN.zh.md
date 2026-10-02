[English](LOGIN.md) · [中文](LOGIN.zh.md)

# 登录、token 交换、刷新与登出，iam/1.0

浏览器、IdP 与 IAM 成员之间的流程，以及 token 端点的各个 profile。路径：[`openapi/iam.openapi.yaml`](openapi/iam.openapi.yaml)。形状：[`schemas/login-config.schema.json`](schemas/login-config.schema.json)、[`schemas/idp-discovery.schema.json`](schemas/idp-discovery.schema.json)、[`schemas/token-response.schema.json`](schemas/token-response.schema.json)。已用真实浏览器对 Casdoor v4.1.0 验证（复现 r1-09）。

## 流程

| # | 谁 | 做什么 |
|---|---|---|
| 1 | 浏览器 → 成员 | `GET /api/iam/login-config?client=pc` 和 `GET /api/tenant/features`（都公开，登录前调用） |
| 2 | 浏览器 → IdP | `GET {discovery_url}`；从中取 `authorization_endpoint`、`token_endpoint`、`end_session_endpoint`；核对它的 `issuer` 等于 `idp.issuer` |
| 3 | 浏览器 → IdP | 跳转到 `authorization_endpoint`，带 `response_type=code`、`client_id`、`redirect_uri`、`scope`（来自 login-config）、`state`、`nonce`、`code_challenge`（32 字节随机 verifier 的 S256）、`code_challenge_method=S256`，再加上 `extra_authorize_params` |
| 4 | IdP → 浏览器 | 这个人在 IdP 自己的页面登录；带 `code` 和 `state` 跳回 |
| 5 | 浏览器 → IdP | `POST token_endpoint`，表单：`grant_type=authorization_code`、`client_id`、`code`、`redirect_uri`、`code_verifier`。不带 client secret：这是公共客户端 |
| 6 | 浏览器 | 核对 `state`（第 3 步）和 ID token 的 `nonce`；ID token 只放进 session storage，留作登出时的 `id_token_hint`；IdP 返回的其它东西全部丢掉 |
| 7 | 浏览器 → 成员 | `POST /api/iam/token`，用下面的登录 profile；拿到平台 access token 和 refresh token |
| 8 | 浏览器 → 组件 | `Authorization: Bearer <平台 access token>` |

- **任何地方都不写厂商路径**：前端只知道 `idp.issuer`、`idp.client_id` 和 `discovery_url`。Casdoor 的端点恰好是 `/login/oauth/authorize` 和 `/api/login/oauth/access_token`，JWKS 是不带 `.json` 的 `/.well-known/jwks`：只有 discovery 说得准。
- `scope` 永远不含 `offline_access`：平台会话是成员的 refresh token，浏览器里的 IdP refresh token 只会增加暴露面。
- **安全来自 PKCE，不是 CORS。** r1-09 发现 Casdoor 会拒绝陌生源的预检，但对表单编码的 token POST（简单请求，不预检）会原样回显任何 `Origin`。真正的保护是：没有 verifier 的码没有用，而且码只能用一次；两条都已验证。

## IdP discovery

成员的 IdP 必须在 `{issuer}/.well-known/openid-configuration` 发布（schema `idp-discovery.schema.json`），否则成员不符合契约：

| 字段 | 必需 |
|---|---|
| `issuer`、`authorization_endpoint`、`token_endpoint`、`jwks_uri` | 是 |
| `response_types_supported` 含 `code` | 是 |
| `code_challenge_methods_supported` 含 `S256` | 是 |
| `id_token_signing_alg_values_supported` 含 `RS256`、`ES256`、`EdDSA` 之一 | 是 |
| `end_session_endpoint` | 可选；login-config 用 `end_session_supported` 说明 |

并且，对一个登记了精确 redirect URI 的公共客户端，IdP 必须：只有 `code_verifier` 正确才兑换授权码；没带 challenge 签出的码，客户端不认证就拒绝兑换；每个码只兑换一次。`iamconf` 对真实 IdP 容器检查以上全部。Casdoor v4.1.0 通过（r1-09，`flow.py` 用例 1–5）。

## token 交换

`POST /api/iam/token`，`application/x-www-form-urlencoded`，公开。成功答 `200`，体符合 `token-response.schema.json`，带 `Cache-Control: no-store`。

### 登录 profile（core）

| 参数 | 值 |
|---|---|
| `grant_type` | `urn:ietf:params:oauth:grant-type:token-exchange` |
| `subject_token` | IdP 的 ID token |
| `subject_token_type` | `urn:ietf:params:oauth:token-type:id_token` |
| `requested_token_type` | 可选；只能是 `urn:ietf:params:oauth:token-type:access_token` |
| `audience` | 可选；必须等于 `TENANT_ID` |
| `client_id` | 可选的平台客户端（`pc`）；必须与 ID token 签给的那个客户端一致 |

成员按顺序：验 subject token（TOKENS，"subject token"）；找到或新建平台用户（TOKENS，"平台 `sub`"），命中时绑定 `BOOTSTRAP_ADMIN_LOGIN`；拒绝已停用的用户（`403 ACCOUNT_DISABLED`）；经 `AUTHZ_URL` 调权限提供方的 `ResolveClaims(sub)`；签 access token；开一个会话（`sid`）并签 refresh token；发 `infra.iam.login.v1`。响应带 `access_token`、`issued_token_type = urn:ietf:params:oauth:token-type:access_token`、`token_type = Bearer`、`expires_in`、`refresh_token`、`refresh_expires_in`。

### 委托 profile（预留，能力 `token_exchange_delegation`）

形状现在定死，以后加上只是新增（A4、A5）；3.0.0 没有成员实现。

| 场景 | 参数 | 结果 |
|---|---|---|
| 扮演，只读（A5） | `subject_token` = 管理员的平台 access token，`subject_token_type = …:access_token`，`requested_subject` = 要扮演的平台 `sub`，`reason` | 成员先在权限提供方调 `CreateDelegation(from_sub = requested_subject, to = {sub: admin, kind: user}, mode = act_as, profiles = [只读扮演 profile], valid_until ≤ now + 15 min)`，由它检查键 `infra.authz.impersonate`；token 的 `sub` = 被扮演的人，`act = {sub: admin, kind: user}`，带 `ceil`、`dg`，`exp` ≤ 委托终点，**不签 refresh token**；`infra.iam.impersonation.started.v1` 通知被扮演的人 |
| agent（A4） | `subject_token` = 用户的 access token，`actor_token` = agent 的凭据，`actor_token_type` | iam/1.0 永不实现；`act.kind = agent` |
| 链式 | 交上来的 `subject_token` 本身已有 `act` | 新 `act` 套住旧的：`{sub: 新操作者, kind, act: 之前的 act}`（RFC 8693 §4.1） |

没有这个能力的成员，以及 iam/1.0 里所有成员面对 `actor_token` 时，都答 `401 UNSUPPORTED_DELEGATION`（domain `be`，code `UNAUTHENTICATED`，与 be-protocol 各处一致）。"代办"式委托（审批人的代理人）根本不需要交换：代理人用自己的 token，委托由权限提供方的 bundle 携带（contract-infra-authz）。

### client credentials（预留，能力 `service_accounts`）

`grant_type=client_credentials`，带 `client_assertion_type = urn:ietf:params:oauth:client-assertion-type:jwt-bearer` 和服务账号私钥签的 `client_assertion`（RFC 7523）。token：`sub = svc:<id>`，`azp = svc`，角色来自 `ResolveClaims("svc:<id>")`，不签 refresh token。没有这个能力时：`400 UNSUPPORTED_GRANT_TYPE`。

## 刷新

`POST /api/iam/token/refresh`，表单 `grant_type=refresh_token&refresh_token=…`，公开（refresh token 自己就是凭据）。

- 轮换（TOKENS，"refresh token"）；重新经 `ResolveClaims` 取角色，所以刷新出的 token 总带当前角色。
- `503 AUTHZ_UNAVAILABLE` 不消耗 refresh token：之后用同一个重试。
- `401 REFRESH_TOKEN_INVALID`：不存在、过期、已作废、过了会话终点，或用户已停用。`401 REFRESH_TOKEN_REUSED`：会话出于安全原因被关闭。
- **前端单飞刷新**：跨标签页同一时刻只刷新一次（Web Locks API，`navigator.locks.request("be-iam-refresh", …)`），其它标签页等它的结果。两个标签页拿同一个 token 刷新会触发重放检测。
- 组件答 `401 TOKEN_STALE`（be-protocol P5.6）时，刷新一次、重试一次。

## 登出

`POST /api/iam/logout`，表单 `refresh_token=…`，带 `Authorization: Bearer <access token>`。

- 若该会话属于调用者的 `sub`，作废这个会话的全部 refresh token。token 不存在或已作废也答 `200`（RFC 7009）。
- 已签出的 access token 到过期前仍有效（最多 access TTL）；撤销一个人靠停用事件加 `stale_since`（DIRECTORY）。
- `end_session_supported` 时，前端接着带 `id_token_hint`（第 6 步留下的）和 `post_logout_redirect_uri` 跳到 IdP 的 `end_session_endpoint`，结束 IdP 自己的会话。已对 Casdoor 验证（r1-09，用例 14）。

## 错误

所有失败都是 problem+json（be-protocol P4），reason 属于 domain `infra/iam`（[`errors.yaml`](errors.yaml)）或是 domain `be` 的保留 reason。三条 token 路径上，`metadata.oauth_error` 带 RFC 6749 §5.2 的错误码，懂 OAuth 的客户端可以据此映射；没有顶层的 `error` 成员（P4.1）。

| 状态 | reason | `oauth_error` | 何时 |
|---|---|---|---|
| 400 | `INVALID_REQUEST` | `invalid_request` | 参数缺失或格式不对 |
| 400 | `UNSUPPORTED_GRANT_TYPE` | `unsupported_grant_type` | 别的 `grant_type`（或成员没有的预留 grant） |
| 400 | `UNSUPPORTED_TOKEN_TYPE` | `invalid_request` | 别的 `subject_token_type` |
| 400 | `INVALID_TARGET` | `invalid_target` | `audience` ≠ `TENANT_ID` |
| 401 | `UNSUPPORTED_DELEGATION`（be） | `invalid_request` | 成员不支持的委托请求 |
| 401 | `SUBJECT_TOKEN_INVALID` | `invalid_grant` | TOKENS "subject token" 的任意一项检查失败，含第二次使用 |
| 401 | `REFRESH_TOKEN_INVALID`、`REFRESH_TOKEN_REUSED` | `invalid_grant` | 刷新 |
| 403 | `ACCOUNT_NOT_LINKED` | `invalid_grant` | 不认识的 IdP 账号且关闭了自动开户 |
| 403 | `ACCOUNT_DISABLED` | `invalid_grant` | 平台用户已停用 |
| 503 | `IDP_UNAVAILABLE` | `temporarily_unavailable` | IdP 的 JWKS 从没拉到过 |
| 503 | `AUTHZ_UNAVAILABLE` | `temporarily_unavailable` | `ResolveClaims` 失败（签发失败即拒签） |
