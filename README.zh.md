[English](README.md) · [中文](README.zh.md)

# contract-infra-iam

IAM 槽位族的族契约，版本 **iam/1.0**：每个身份成员要实现什么，SDK、前端、权限成员和一致性套件消费什么。这里只有契约：没有成员代码，没有逻辑。

## 这是什么

- **provider 契约** `infra.iam.v1`：登录配置；token 交换（RFC 8693），含登录 profile 和预留的委托 profile；刷新与登出；access / refresh token 的形状；JWKS 与签发方元数据；平台自有的 `sub` 及其身份链接；目录事件；系统面读接口 `IamProvider`；SCIM 入站；能力枚举；错误 reason；NDJSON 导出；锁定验签规则的 token 向量。
- **不在这里**：组件运行时怎么验 token、怎么回答 stale（be-protocol P5，claims 引用本仓库）；身份确定之后能做什么（`contract-infra-authz`）；IdP 服务本身，它是基础设施（`make up`，决策 0106）。
- **消费方**：官方 SDK（claims，`IAM_ISSUER` / `TENANT_ID` / `IAM_JWKS_URL`，`vectors/tokens/access-token.json`）；前端（login-config、discovery、token 端点、刷新、登出、能力）；权限成员（`infra.iam.user.*` 事件用于 `stale_since` 和初始管理员，声明了能力时还有部门）；要显示人名的组件（`BatchGetUsers`、`ListUsers`、用户事件）；`tools/be-acceptance/conformance/iam/`。

## 成员

| 成员 | 状态 | 声明（`provides_capabilities`） | 适合 |
|---|---|---|---|
| `infra/iam-casdoor`（默认） | 3.0.0 实现 iam/1.0 | core、password_login、social_cn、mfa；ldap、saml 视 Casdoor 配置；directory_departments 以后 | 国内中小客户，单机 |
| `infra/iam-keycloak` | 阶段 06，第二个成员 | core、password_login、ldap、saml、mfa、directory_departments | AD / LDAP 联邦、SAML、大型企业（JVM 内存） |
| 通用 OIDC + SCIM 成员 | 计划中，第三个成员 | core、scim_inbound、directory_departments | 客户自带 Entra ID、Okta、Authentik 或钉钉统一身份 |

`token_exchange_delegation` 和 `service_accounts` 是**预留**的：形状在这里定死，3.0.0 没有成员声明。`act.kind = agent` 按 A4 预留，永不签发。

## 目录结构

| 路径 | 内容 |
|---|---|
| [`TOKENS.zh.md`](TOKENS.zh.md) | access 与 refresh token、签发方、签名钥匙、验签（组件侧）、subject token 验证（成员侧）、平台 `sub`、初始管理员 |
| [`LOGIN.zh.md`](LOGIN.zh.md) | 浏览器流程、对 IdP discovery 的要求、token 交换的各个 profile、刷新、登出、错误 |
| [`DIRECTORY.zh.md`](DIRECTORY.zh.md) | 平台用户、事件、部门、读接口、SCIM 入站、导出与换成员 |
| `proto/infra/iam/v1/provider.proto` | gRPC 服务 `IamProvider` |
| `openapi/iam.openapi.yaml` | 成员的 REST 面（OpenAPI 3.1） |
| `openapi/extensions/` | 成员专属路径（Casdoor webhook），[规则](openapi/extensions/README.zh.md) |
| `schemas/` | access token、refresh token、JWKS、服务端元数据、login-config、tenant features、token 响应、IdP discovery 要求、导出记录 |
| `examples/` | 每个 schema 的正例与反例、Casdoor v4.1.0 的真实 discovery 文档、一份导出文件 |
| `capabilities.yaml` | 能力枚举：core 与可选、成员必须做什么、缺失时怎么降级 |
| `errors.yaml` | 族的错误 reason，domain `infra/iam` |
| `events/iam.events.json` | 目录事件与审计事件 |
| `vectors/` | 验签向量、测试钥匙、生成器与独立交叉校验（[README](vectors/README.zh.md)） |
| `gen/go/infra/iam/v1` | 生成的 Go 包 `iamv1`（提交进仓库） |
| `fs.go`、`go.mod` | Go 模块 `github.com/brickKit/contract-infra-iam`，以 `iamcontract.FS` 嵌入上面的文件 |

## 寻址与两个面

- **共享键**（`config/vars.yaml`）：`IAM_URL`（成员按自己服务名的基地址）、`IAM_JWKS_URL`（= `{IAM_URL}/.well-known/jwks.json`）、`IAM_ISSUER`（稳定的名字，推荐 `urn:be:<TENANT_ID>:iam`；不是地址，换成员不变）、`TENANT_ID`、`BOOTSTRAP_ADMIN_LOGIN`。没有组件声明对 IAM 成员的依赖，IAM 成员也不声明对权限成员的依赖：它经 `AUTHZ_URL` 访问（0104、0107）。
- **边缘**（未注明的都是公开）：`/api/iam/login-config`、`/api/tenant/features`、`/api/iam/token`、`/api/iam/token/refresh`、`/api/iam/logout`（要登录）、`/api/admin/iam/*`（键 `infra.iam.admin`）、`/scim/v2/*`（能力 `scim_inbound`，SCIM 密钥）。
- **只在项目网络**：`/.well-known/jwks.json`、`/.well-known/oauth-authorization-server`、成员 `grpc` 端口上的 gRPC 服务（调用方带 `be-caller`），以及 `/api/iam/webhooks/casdoor` 这类成员扩展。
- **每个成员都有、名字统一的配置**：`APP_TOKEN_SIGNING_KEY_PEM`（密钥）、`APP_TOKEN_PREVIOUS_PUBLIC_KEY_PEM`、`APP_TOKEN_TTL_SECONDS`（600）、`REFRESH_TOKEN_TTL_SECONDS`（604800）、`IAM_AUTO_PROVISION`（true）、`IAM_LINK_BY_EMAIL`（false）、`IAM_CLIENTS`（平台客户端：`azp` → IdP client id）。连 IdP 的键各成员自定。

## 能力

- **core** 不可选：login-config、tenant features、服务端元数据、带轮换的 JWKS、token 交换的登录 profile、带重放检测的 refresh 轮换、登出、平台 `sub` 与身份链接、从 `ResolveClaims` 取角色且失败即拒签、用户事件、`BatchGetUsers`、`ListUsers`、导出与导入。
- **可选**：`password_login`、`social_cn`、`ldap`、`saml`、`mfa`（IdP 提供什么；登录页据此降级），`scim_inbound`、`directory_departments`；预留：`token_exchange_delegation`、`service_accounts`。
- **协商**：组装期，成员的 `assembly.yaml` 写 `provides_capabilities`，组件写 `requires_capabilities`（与 authz 同一个门禁）；运行期，`GET /api/tenant/features` 和服务端元数据列出正在运行的成员提供什么。
- **缺失是明确且可测的**：未声明能力的操作答 `501` / `UNIMPLEMENTED`，reason `CAPABILITY_UNAVAILABLE`（domain `be`）并带 `metadata.capability`，或 `capabilities.yaml` 指名的那个 `400`。
- 名字只增不改；不认识的名字一律忽略。

## 版本

- `contract` 写作 `iam/1.<minor>`（出现在 login-config、tenant features、服务端元数据、导出头）；Go 模块与仓库 tag 是 `v1.<minor>.<patch>`（只有带 `v` 的 tag：这不是 brickKit 组件）。
- **minor** 只增：可选 claim、能力、rpc、端点、参数、事件 subject 与 payload 字段、导出 kind、错误 reason、新规则的向量。不改任何含义；每个新能力都是可选的。
- **patch**：措辞、示例、给已有规则补向量。
- **major**（`iam/2`）是新的 proto 包 `infra.iam.v2`、模块路径 `/v2`、新 subject `….v2`，两个主版本都装着时并行提供。
- 门禁：对上一个 tag 跑 `buf breaking`（FILE）（`make breaking AGAINST=v1.0.0`）；能力名、reason、subject、向量 ID 只增不改。
- 成员、SDK、套件各钉一个精确 tag。be-protocol 只引用主版本（"`iam/1`"）。

## 生成代码

**决定**（与 contract-infra-authz 相同）：Go 代码在这里生成、由本模块发布；其它语言从钉死的 tag 私下生成。

| 语言 | 什么 | 在哪 |
|---|---|---|
| Go | `protoc-gen-go` v1.36.6 + `protoc-gen-go-grpc` v1.5.1 的输出，随改 proto 的那个 tag 一起提交（`make gen`；过期时 `make gen-check` 失败） | `github.com/brickKit/contract-infra-iam/gen/go/infra/iam/v1`（包 `iamv1`）；契约文件经 `iamcontract.FS` |
| Python、TypeScript | 1.0 不发包；一个进程里唯一的消费者（SDK，或在 SDK 包装 `IamProvider` 之前的那个组件）从钉死的 tag 拷贝 `proto/`、`schemas/`、`vectors/`，核对 `vectors/SHA256SUMS`，私下生成 | 在那个消费者里 |
| 前端 | 生成器从钉死的 tag 读 `openapi/iam.openapi.yaml` 和 `errors.yaml` | 前端仓库 |

- **Go 里每个进程只能有一份生成包，这是硬约束**：protobuf 运行时按全名注册 `infra.iam.v1.*`，外壳二进制里两份副本（Casdoor 成员的服务端和某个调用方的客户端，都在 `be/go-infra`）启动时冲突。Go 的最小版本选择保证一个外壳只有本模块的一个版本。
- 族契约不再放在 Casdoor 成员仓库里（那里的 `contracts/infra/iam/v1`、包 `infra-iam-casdoor/gen/infra/iam`）：有了第二个成员，Keycloak 就得依赖 Casdoor 的仓库。0101 增加"族契约包"作为第三类可以跨边界的包（contract-infra-authz 写明了这条增补，两个族都适用）。
- 等到一个进程里可能出现第二个 Python 或 TypeScript 消费者时，本仓库增加可安装的 `python/`、`ts/` 包，消费者在同一个版本里切过去。

## 证明符合

套件 `tools/be-acceptance/conformance/iam/`（`iamconf`）。它自带一个签 ID token 的测试 OIDC 提供方（也签带 refresh 标记、access 标记的 token），或者对成员真实的 IdP 容器跑。

1. 在成员的 `assembly.yaml` 写 `provides_capabilities`，并在 tenant features 和服务端元数据里公布同一组。
2. 对运行中的成员跑套件：
   - **core**：IdP 的 discovery 通过 `idp-discovery.schema.json` 和 LOGIN 里的 PKCE 检查；login-config、tenant features、元数据、JWKS 符合各自 schema；按 RFC 8693 登录 profile 交换出的 token 符合 `access-token.schema.json`；成员的端点按每条 subject-token 向量拒收；同一个 subject token 第二次用失败；refresh 当 access 用被夹具组件拒收；轮换后旧 refresh 立刻失效、重放会结束会话；轮换期间新旧钥匙都能验过；同一 IdP 账号两次登录 `sub` 不变；`BOOTSTRAP_ADMIN_LOGIN` 只绑定一次且事件带 `bootstrap_admin`；停用事件 30 s 内发出且下一次交换被拒；导出、导入到新成员，同一 IdP 账号仍得到同一个 `sub`；`ResolveClaims` 不通时答 `503` 且不签 token；
   - 声明了的可选能力通过各自分组（`login_methods`、`scim`、`directory`）；
   - 没声明的按 `capabilities.yaml` 回答。
3. 套件把能力矩阵写进该成员版本的测试记录；`make gates` 检查记录存在。
4. 每个官方 SDK 通过 `vectors/tokens/access-token.json`；每个成员在单元测试里通过 `vectors/tokens/subject-token.json`。

## token 向量

78 条用例（access token 51 条、subject token 27 条），ID 稳定、永不复用。由 `vectors/tools/gen.mjs` 写出（Node `node:crypto`，结论按 TOKENS 手写），由 `vectors/tools/check` 交叉校验（Go 标准库，不用任何 JWT 库，与生成器不共享代码）；两者都先在篡改过的向量上见过红。再用 `jose` 6 跑一遍，发现了 JWT 库的两处缺口，向量现在都能抓到（[vectors/README.zh.md](vectors/README.zh.md)）。

## 实测依据

复现 r1-09（2026-10-02，Casdoor v4.1.0，真 Chromium）：discovery 完整并声明 S256；公共客户端在浏览器里按 discovery 给的端点走完授权码 + PKCE；错的、缺的 verifier 和重复使用的码都被拒；Casdoor 的 ID token 与 access token 是同一个 JWT，`aud` = client id，没有 `typ` claim，`tokenType: access-token`；它的 refresh token 是同一把钥匙签的 JWT，不带 `kid`，`tokenType: refresh-token`；它自带的 token exchange 要 client secret，签出的仍是 Casdoor 形状的 token。每一条发现都成了 TOKENS 或 LOGIN 里的一条规则和一条向量。

## 在本仓库工作

- `make check` = `lint`（buf）+ `gen-check` + `build`（go vet、build、gofmt）+ `vectors-check` + `validate`（JSON Schema、示例、导出格式、事件、能力、reason、OpenAPI、签发方形状的向量），全部在一次性容器里跑。
- 改动顺序固定：proto / OpenAPI / schema → 正文（`TOKENS.md`、`LOGIN.md`、`DIRECTORY.md`）及中文镜像 → `gen.mjs` 和校验器里的用例 → `make vectors` → `make check` → 打 tag。
- 文档：英文为准，中文镜像 `*.zh.md` 放在旁边，`##` 小节相同。
