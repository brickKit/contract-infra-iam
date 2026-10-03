[English](TOKENS.md) · [中文](TOKENS.zh.md)

# token、钥匙与验签，iam/1.0

IAM 成员签发什么、怎么公布钥匙、组件怎么验 access token、成员怎么验它收到的 IdP token。形状：[`schemas/access-token.schema.json`](schemas/access-token.schema.json)、[`schemas/refresh-token.schema.json`](schemas/refresh-token.schema.json)、[`schemas/jwks.schema.json`](schemas/jwks.schema.json)、[`schemas/server-metadata.schema.json`](schemas/server-metadata.schema.json)。用例：[`vectors/`](vectors/README.zh.md)。组件一侧同时也是 be-protocol 的 P5；两份文字说的是同一件事，这一份多了签发方一侧。

## 两种 token，绝不混用

| | IdP token | 平台 token |
|---|---|---|
| 签发方 | IdP（Casdoor、Keycloak、客户自己的 IdP） | 安装的 IAM 成员 |
| 受众 | 平台客户端在 IdP 那边的 client id | `TENANT_ID` |
| `sub` | IdP 的 subject（Casdoor：它的用户 UUID） | 平台用户 id，平台自有的 UUIDv7 |
| 谁会看到 | 浏览器（一次）和成员的 token 交换 | 每个组件、每个请求 |
| 谁来验 | 只有成员（下面的"subject token"） | 每个组件（be-protocol P5，下面的"验签"） |

组件从不接受 IdP token，成员也从不转发它。复现 r1-09 说明这条隔离不需要额外代码：Casdoor 的 token `aud` 是它的 client id、没有 `typ` claim，组件的 `aud` 检查和 `typ` 检查各自都能拒掉它（向量 `AT-038`）。

## access token

claims（签发方一侧；验签方更宽松，见"验签"）：

| claim | 必填 | 值 |
|---|---|---|
| `iss` | 是 | `IAM_ISSUER` |
| `aud` | 是 | `[TENANT_ID]`，第一个元素是 `TENANT_ID` 的数组；其它受众预留 |
| `sub` | 是 | 平台用户 id（UUIDv7），服务账号是 `svc:<id>`（预留） |
| `typ` | 是 | `"access"` |
| `iat`、`nbf` | 是 | 签发时刻；`nbf` = `iat` |
| `exp` | 是 | `iat` + access TTL：默认 600 s，最多 3600 s |
| `jti` | 是 | UUIDv7，每个 token 唯一 |
| `tenant_id` | 是 | `TENANT_ID`（一个部署就是一个租户，F1）；从不签 `org_id` |
| `azp` | 是 | 平台客户端：`pc`、`mobile`……；服务账号是 `svc` |
| `roles` | 有就签 | 来自权限提供方 `ResolveClaims` 的角色码；永远不放权限键（0203） |
| `dept_path` | 有就签 | 来自 `ResolveClaims`，`/<id>/…/`；没有部门时**不签这个 claim**，绝不签 `""`，也绝不签 `"/"`（be-protocol P6.4） |
| `locale` | 知道就签 | BCP 47，给服务端渲染的文字用 |
| `act` | 只在委托时 | `{sub, kind, act?}`（RFC 8693 §4.1）；`kind` 是 `user`、`svc` 或 `agent`（预留，A4） |
| `ceil`、`dg` | 只在委托时 | 天花板 profile 码和来自权限提供方 `CreateDelegation` 的委托 id；总是成对出现，总是和 `act` 一起 |

- 头：`alg`（`RS256`、`ES256` 或 `EdDSA`，即签名钥匙的算法）、`kid`、`typ: "JWT"`。验签方忽略头里的 `typ`。
- **签发失败即拒签**：`roles`、`dept_path`、`tenant_id` 在登录和每次刷新时都从 `ResolveClaims` 取。取不到时成员答 `503 AUTHZ_UNAVAILABLE`，什么也不签；绝不沿用旧角色。
- 体积：不放权限键，不放用户资料。token 远小于 4 KiB。

## refresh token

- 对前端和每个组件都是不透明的。成员**可以**用任何格式。
- 如果它是用已公布的钥匙签的 JWT，就**必须**符合 `refresh-token.schema.json`：`typ: "refresh"`，`aud: [IAM_ISSUER]`（绝不是 `TENANT_ID`），`sid`（会话 id），`jti`（这一个 token），`exp` 不晚于会话终点。这样组件的验签会从两处拒掉它：`aud` 不对、`typ` 不对（向量 `AT-039`）。
- **轮换**：每次刷新返回一个新 refresh token，`jti` 新、`sid` 不变；交上来的那个立刻失效。
- **重放检测**：交上来一个已经轮换过的 refresh token，就作废同一个 `sid` 的全部 token，答 `401 REFRESH_TOKEN_REUSED`（OAuth 2.0 Security BCP）。没有宽限窗口；前端跨标签页单飞刷新（LOGIN）。
- **会话绝对终点**：登录时刻 + `REFRESH_TOKEN_TTL_SECONDS`（默认 7 天）。轮换永不延长它。
- 成员只存 refresh token 的哈希。

## 签发方

- `IAM_ISSUER` 是**这个部署的平台签发方的稳定名字**，不是某个成员的地址：换成员时它不变（DIRECTORY，"换成员"）。推荐形式 `urn:be:<TENANT_ID>:iam`。它绝不是成员的服务名，也绝不是 IdP 的 issuer。
- `IAM_URL` 是成员按自己服务名的基地址，在 `config/vars.yaml` 里写一次，写成 `$endpoint:<成员 ID>`（与 `AUTHZ_URL` 相同做法，be-protocol P2.10）。换成员它就变。
- **服务端元数据**在 `{IAM_URL}/.well-known/oauth-authorization-server`，形状是 RFC 8414 再加 `be_contract`、`be_member`、`be_capabilities`、`be_tenant_id`。因为 issuer 是名字不是 URL，位置相对于 `IAM_URL` 而不是 issuer；这是唯一一处刻意偏离 RFC 8414 的地方。只在项目网络。

## 签名钥匙

| 规则 | |
|---|---|
| 位置 | `{IAM_URL}/.well-known/jwks.json`，组件从这里拉取（be-protocol P5.4）；没有单独的地址键。只在项目网络，永远不是边缘路由 |
| 算法 | `RS256`（RSA ≥ 2048 位）、`ES256`（P-256）、`EdDSA`（Ed25519）。不用 HMAC，不用 `none` |
| 每把钥匙 | `kid`（唯一、永不复用；**应当**是 RFC 7638 指纹）、`alg`、`use: "sig"`，只有公钥成员 |
| 公布几把 | 1 到 3 把：当前钥匙；轮换期间的上一把；可选地提前公布下一把 |
| 轮换 | 下一把至少提前 1 h 公布再用来签（组件最多缓存 JWKS 1 h，P5.4）；切换之后上一把至少再留 access TTL + 60 s，然后撤下。钥匙是成员会重读的文件（be-protocol P2.9），所以不用重启：(1) 把新私钥写进 `APP_TOKEN_NEXT_SIGNING_KEY_FILE` 再 `up`；每个副本在 30 s 内公布它的公钥；(2) 至少 1 h 之后，把它写进 `APP_TOKEN_SIGNING_KEY_FILE`，清空下一把，再 `up`；成员从此用它签；(3) 成员在自己的 schema 里记下签过名的每把钥匙的公钥和停用时间，停用后继续公布 access TTL + 60 s，跨重启、跨副本都成立 |
| 缓存 | `Cache-Control: public, max-age` ≤ 3600 |
| 私钥 | 密钥文件 `APP_TOKEN_SIGNING_KEY_FILE` 和 `APP_TOKEN_NEXT_SIGNING_KEY_FILE`（`mount: file`；在 `config/` 里用 `file://` 或 `${VAR}` 填写，Kubernetes 上也可以是 `existingSecret`，由 cert-manager 之类的工具轮换），不进镜像，不进环境变量，不进日志 |

撤下一把钥匙，就结束了用它签的全部 access token；换成员时旧成员的 token 就是这样失效的（DIRECTORY）。

## 验签

每个组件、任何语言，怎么验 access token。对 SDK 是规范性的，由 `vectors/tokens/access-token.json`（51 条）锁定。按顺序检查，第一处失败决定回答。

| # | 检查 | 失败 |
|---|---|---|
| 1 | `Authorization: Bearer <紧凑 JWS>`，三段 base64url，头和 payload 都是 JSON 对象 | 401 `TOKEN_INVALID` |
| 2 | 头的 `alg` ∈ {`RS256`, `ES256`, `EdDSA`}；有 `kid`；JWKS 里有这个 `kid` 的钥匙（最多一次限速的重新拉取之后），且它的 `alg` 与头一致 | 401 `TOKEN_INVALID` |
| 3 | 用这把钥匙验签通过 | 401 `TOKEN_INVALID` |
| 4 | 类型：`roles`、`ceil` 是字符串数组；`dept_path`、`tenant_id`、`azp`、`locale`、`dg` 是字符串；`act` 是对象，`sub` 非空，`kind` ∈ {`user`, `agent`, `svc`}，嵌套的 `act` 同样合法 | 401 `TOKEN_INVALID` |
| 5 | `iss` = `IAM_ISSUER` | 401 `TOKEN_INVALID` |
| 6 | `aud` 是字符串或字符串数组，且包含 `TENANT_ID` | 401 `TOKEN_INVALID` |
| 7 | `typ` = `"access"`（缺 `typ` 也失败） | 401 `TOKEN_INVALID` |
| 8 | `sub` 是非空字符串 | 401 `TOKEN_INVALID` |
| 9 | `exp` 是数字且 `now < exp + 60` | 401 `TOKEN_INVALID` |
| 10 | 有 `nbf` 时它是数字且 `nbf ≤ now + 60` | 401 `TOKEN_INVALID` |
| 11 | `iat` 是数字且 `iat ≤ now + 60` | 401 `TOKEN_INVALID` |
| 12 | `jti` 是非空字符串 | 401 `TOKEN_INVALID` |
| 13 | bundle 的 `agents` 为 false 时，`act` 链上任何一环是 `agent`；`delegation` 为 false 时带 `ceil` 或 `dg` | 401 `UNSUPPORTED_DELEGATION` |
| 14 | 有 `stale_since[sub]` 且 `iat < stale_since[sub] − 5` | 401 `TOKEN_STALE`，`WWW-Authenticate: Bearer error="token_stale"` |

- 不认识的 claim 忽略。`org_id` 读但不用。
- 所有失败的 domain 都是 `be`。具体哪一项失败只进日志，不进响应。
- **只靠 JWT 库不够**：没有库检查 `typ` 和 claim 类型；有的库接受含非字符串成员的 `aud` 数组，或者从不检查未来的 `iat`（向量 README，"缺口"）。SDK 自己补上这些检查。

## subject token

成员怎么验交给 `POST /api/iam/token` 的 IdP ID token（LOGIN）。由 `vectors/tokens/subject-token.json`（27 条）锁定。失败是 401 `SUBJECT_TOKEN_INVALID`（domain `infra/iam`，`metadata.oauth_error = invalid_grant`）。

| # | 检查 |
|---|---|
| 1–3 | 紧凑 JWS；`alg` 在成员的白名单里（⊆ {`RS256`, `ES256`, `EdDSA`}）且等于 IdP JWKS 那把钥匙的 `alg`；`kid` 必填；用 IdP 的 JWKS 验签通过（地址取自 IdP discovery 的 `jwks_uri`，在项目网络里拉） |
| 4 | `iss` = 浏览器看到的 IdP issuer（discovery 的 `issuer`），即使成员用别的地址访问 IdP |
| 5 | `aud`（字符串或数组）包含一个受信任的 IdP client id（每个平台客户端一个）；多个受众时 `azp` 必填；有 `azp` 时它必须是受信任的 client id（OIDC Core 3.1.3.7）。受信任的那个 client 决定签出 token 的 `azp` |
| 6 | `sub` 非空 |
| 7 | `now < exp + 60`；`iat` 必须有，`iat ≤ now + 60`，且 `now − iat ≤ max_age + 60`（max_age 默认 600 s）；有 `nbf` 时检查 |
| 8 | **不是 IdP 的 refresh 或 access token**：有 `typ` claim 时必须等于 `ID`（不区分大小写；Keycloak 用 `Refresh`、`Bearer` 标记）；有 `tokenType` claim 时必须是 `access-token` 或 `id-token`（Casdoor 用 `refresh-token` 标记；它的 ID token 和 access token 是同一个 JWT，复现 r1-09） |
| 9 | **只能用一次**：同一个 subject token（紧凑形式的 SHA-256）在过期前最多交换一次；第二次失败 |

- `nonce` 由生成它的前端检查；成员检查不了。
- Casdoor 的 refresh token 不带 `kid`（r1-09），所以第 2 项已经会拒掉它；第 8 项独立再拒一次，结果不依赖那个巧合（向量 `ST-020`、`ST-021`）。

## 平台 `sub`

- IdP 账号第一次登录、成员从没见过它时，成员生成平台 `sub`（UUIDv7），并维护 `identity_links(sub, idp, idp_issuer, idp_sub, linked_at, method)`，每个 IdP 账号一行。自然键是 `(idp_issuer, idp_sub)`。
- 把 IdP 账号链接到已有的平台用户：

| `method` | 什么时候 | 默认 |
|---|---|---|
| `exact` | `(idp_issuer, idp_sub)` 那一行已存在 | 永远 |
| `first_login` | 没有那一行，下面的规则也都没命中：新建平台用户 | 开；`IAM_AUTO_PROVISION=false` 时改答 `403 ACCOUNT_NOT_LINKED` |
| `email` | 没有那一行；恰好一个平台用户有这个邮箱，且 IdP 说 `email_verified: true` | **关**；有安全风险，按部署选择开启 |
| `username` | 没有那一行；恰好一个平台用户有这个登录名、且还没有到这个 issuer 的链接，并且在迁移窗口内 | 关；只用于换成员 |
| `import`、`scim`、`admin` | 由导入、SCIM 推送或管理员写入的行 | — |

- `sub` 永不复用、永不修改，换成员时经导出保留。业务数据（`owner_id`、角色分配、审计）只引用它。

## 初始管理员

平台 `sub` 要等一个人第一次登录才存在，所以部署者没法按 `sub` 指定第一个管理员。

- 共享配置键 `BOOTSTRAP_ADMIN_LOGIN`（`config/vars.yaml`）：第一个管理员在 IdP 的登录名，或邮箱。
- 登录交换时，成员拿它与 IdP 账号的登录名（`preferred_username`；Casdoor 是 `name`）做不区分大小写的比较，或者在 IdP 说 `email_verified: true` 时与 `email` 比较。每个部署最多绑定一次：第一次命中生效，绑定落库，之后再命中什么也不改。
- 绑定时，成员发普通的目录事件，payload 里带 `bootstrap_admin: true`：这是此人第一次登录时发 `infra.iam.user.created.v1`；设这个键之前此人已存在时发 `infra.iam.user.updated.v1`。权限成员据此授予它们的初始管理员角色，幂等（contract-infra-authz）。角色在下一次刷新时出现在 token 里。
- 绑定随导出一起走（`user.bootstrap_admin`），导入方因此永远不会再绑定第二个人。
- 键没设或为空就不绑定任何人。绑定之后再改这个键没有效果；之后的管理员在权限提供方里授予。
