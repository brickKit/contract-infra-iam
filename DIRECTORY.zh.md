[English](DIRECTORY.md) · [中文](DIRECTORY.zh.md)

# 目录、事件、导出与换成员，iam/1.0

IAM 成员所持有的平台用户、变更怎么传给其它组件、客户的 IdP 怎么把用户推进来、整套身份状态怎么搬到另一个成员。事件：[`events/iam.events.json`](events/iam.events.json)。读接口：[`proto/infra/iam/v1/provider.proto`](proto/infra/iam/v1/provider.proto)。导出：[`schemas/export-record.schema.json`](schemas/export-record.schema.json)，示例 [`examples/export.ndjson`](examples/export.ndjson)。

## 平台用户

- 成员为每个平台用户存一行：`sub`、`status`（`active` | `disabled`）、`username`、`display_name`、`email`、`email_verified`、`phone`、`locale`、`im_accounts`、`version`，外加身份链接（TOKENS，"平台 `sub`"）。
- 资料在每次登录、以及成员得知的每次目录变更时从 IdP 复制过来；IdP 仍是资料的来源，成员是 `sub` 和 `status` 的来源。
- **停用**（在 IdP 里停用、SCIM `active=false`、或管理员操作）：成员在一个事务里把 `status` 置为 `disabled`、作废这个 `sub` 的全部 refresh token、往 outbox 写 `infra.iam.user.disabled.v1`；从得知变更起 30 s 内发出。权限成员消费它并设置 `stale_since[sub]`，于是已签出的 access token 在一次 bundle 轮询内（约 15 s，be-protocol P6.1）失效，而不是等到过期。
- **删除**就是擦除：成员删掉资料和身份链接，只留下光秃秃的 `sub` 以免复用，并发 `infra.iam.user.deleted.v1`；消费者擦掉自己为这个 `sub` 存的东西。
- 用来做判定的角色和部门不在这里：它们经 `ResolveClaims` 来自权限提供方。

## 成员怎么得知变更

这是成员自己的事，不属于族契约的面：

| 成员 | 机制 |
|---|---|
| `infra/iam-casdoor` | Casdoor webhook 回调 `POST /api/iam/webhooks/casdoor`（成员扩展）；每次投递只说明谁变了，成员回读 Casdoor，所以到达顺序无关紧要；定期对账兜住丢失的投递 |
| `infra/iam-keycloak` | 轮询 Keycloak 的 admin events |
| 通用 OIDC + SCIM 成员 | SCIM 2.0 入站（见下）加上每个 ID token 里的资料 |

## 事件

全部是状态模式（foundations 13）：每个 payload 都是聚合在 `ce-aggregateversion` 那一版的完整状态，消费者跳过或乱序收到版本仍会收敛。

| subject | 聚合 | payload | 能力 |
|---|---|---|---|
| `infra.iam.user.created.v1` | `infra.iam.user`（`ce-subject` = `sub`） | 用户状态；绑定那一条带 `bootstrap_admin: true` | core |
| `infra.iam.user.updated.v1` | `infra.iam.user` | 用户状态（含重新启用） | core |
| `infra.iam.user.disabled.v1` | `infra.iam.user` | 用户状态，`status: disabled` | core |
| `infra.iam.user.deleted.v1` | `infra.iam.user` | `{sub, status: deleted, deleted_at}`；最后一版 | core |
| `infra.iam.department.{created,updated,deleted}.v1` | `infra.iam.department`（`ce-subject` = `department_id`） | 部门状态 | `directory_departments` |
| `infra.iam.membership.changed.v1` | `infra.iam.user_membership`（`ce-subject` = `sub`） | 这个用户的全部部门归属 | `directory_departments` |
| `infra.iam.login.v1` | `infra.iam.session`（`ce-subject` = `sid`） | 只给审计用 | core，旁路 |
| `infra.iam.impersonation.started.v1` | `infra.iam.delegated_session` | 预留（A5） | `token_exchange_delegation` |

- `ce-source` 是成员的组件 ID；`ce-dataschema` 是 `contract-infra-iam@<tag>/events/iam.events.json#<subject>`。subject 属于这个族：每个成员发同样的 subject，换成员时没有消费者要改。
- 用户状态：`sub`、`status`、`display_name`（必填）、`username`、`email`、`email_verified`、`phone`（E.164）、`locale`、`im_accounts[{channel, account_id}]`。不放 token，不放密钥，不放 IdP 的 subject。
- 部门归属是单独的聚合、有自己的版本，所以资料变更和归属变更永不互相抢。

## 来自目录的部门（`directory_departments`）

- 很多 IdP 有组织树（Casdoor 分组、Keycloak 分组、SCIM Groups、钉钉部门）。声明了 `directory_departments` 的成员给每个部门生成平台 `department_id`（UUIDv7），维护 `department_link(department_id, idp_issuer, idp_group_id)`，并发部门和归属事件。
- **这些事件报告的是 IdP 的树；它们本身不定义平台的部门树**（`dept_path` 由那棵树生成）。哪个组件拥有那棵树，在 mdm/org 的设计里定（P2）。在那之前它归权限提供方（contract-infra-authz 的 `user_dept`），权限提供方**可以**消费这些事件来同步它。
- 没有这个能力时，`ListDepartments` 和 `ListMemberships` 答 `UNIMPLEMENTED` / `CAPABILITY_UNAVAILABLE`，部门只在权限提供方里管理。

## 读接口（系统面）

`infra.iam.v1.IamProvider`，在成员的 `grpc` 端口，经 `IAM_URL` 访问（永远不建依赖边；gRPC 目标是 URL 的主机加端口 + 1000，be-protocol P2.10，所以成员把自己的 `grpc` 端口登记为 HTTP 端口 + 1000），带 `be-caller`：

| rpc | 用途 | 上限 |
|---|---|---|
| `BatchGetUsers` | 一批 `sub` 的显示名和联系方式（唯一合法的方式，不许 N+1） | 500 个 sub；不认识的省略；已删除的省略 |
| `ListUsers` | 在跟随事件之前回填用户快照（be-protocol P15） | 每页 ≤ 500，不透明游标，按 `(updated_at, sub)` 排序 |
| `ListDepartments`、`ListMemberships` | 部门的同类操作，能力 `directory_departments` | 每页 ≤ 500 |

没有"按 IdP subject 查用户"：IdP 的 subject 从不离开成员。

## SCIM 入站（`scim_inbound`）

给用推送方式开通用户的客户 IdP（Entra ID、Okta、Authentik、钉钉统一身份）。

- 端点在 `/scim/v2/` 下：`Users`、`Groups`（需 `directory_departments`）、`ServiceProviderConfig`、`Schemas`、`ResourceTypes`（RFC 7643、RFC 7644）。是边缘路由，用成员的 SCIM bearer 密钥（密钥类配置）认证，常量时间比较；从不用平台 token。
- 推送进来的用户成为平台用户，带一条 method 为 `scim` 的身份链接，键是推送方 IdP 的 issuer 下的 SCIM `externalId`（或 `id`）；这个人之后经 OIDC 登录时，成员按配置的 SCIM 到 OIDC 属性（默认 `userName` = `preferred_username`）把 ID token 的 `(iss, sub)` 链接到同一个平台用户。
- `active: false` 即停用；`DELETE` 也是停用（擦除是管理员操作，不是 SCIM 的副作用）。

## 换成员

导出里有新成员保住每一个 `sub` 所需的一切。

| 步骤 | |
|---|---|
| 1 | 从旧成员导出：`GET /api/admin/iam/export`（键 `infra.iam.admin`），格式 `iam-export/1` |
| 2 | 按新 IdP 支持的方式把人搬进去（Keycloak 的 partial import 可以保留每个用户的 id；客户的 IdP 里本来就有这些人） |
| 3 | 导入新成员：先 `POST /api/admin/iam/import?dry_run=true`，再去掉 `dry_run`。到旧 IdP 的身份链接保留（它们不再命中登录，但允许再换回去）。对新 IdP，要么导入预先映射好的 `identity_link` 行（`method: import`），要么为每个人的第一次登录打开 `username` 链接窗口（TOKENS） |
| 4 | `brickkit add` 新成员，`brickkit remove` 旧成员；把 `config/vars.yaml` 里的 `IAM_URL` 和 `IAM_JWKS_URL` 改成新成员的服务名。`IAM_ISSUER` 和 `TENANT_ID` 不变 |
| 5 | 大家重新登录：旧成员的钥匙已不在 JWKS 里。对新成员跑 `iamconf` |

**格式 `iam-export/1`**：UTF-8 NDJSON，LF 换行，无空行；第一行 `header`（`format`、`contract`、`member`、`exported_at`、`tenant_id`、`issuer`、`kinds`），最后一行 `footer`（每种 kind 的 `counts`、两者之间每一行连同其 LF 的 `sha256`）；记录按 `user`、`identity_link`、`department_link`、`department`、`membership` 的顺序分组，组内按自然键排序，所以同一状态的两次导出只有 `exported_at` 不同。与 `authz-export/1` 同一套框架。

**导入规则**：一个事务，全有或全无。header 的 `tenant_id` 与 `TENANT_ID` 不同、契约主版本不是 `iam/1`、footer 对不上时拒绝（`400 IMPORT_INVALID`）。遇到第一个冲突就停（`409 IMPORT_CONFLICT`，带行号）：某个 `(idp_issuer, idp_sub)` 已链接到另一个 `sub`，或某个 `sub` 已有的行与文件不一致。header 里没有的 kind 是"没搬过来"，绝不是"空"。用户版本从导入的版本往上接，消费者的游标仍然有效。导入方不为导入的用户发 `created` 事件（消费者早就知道他们）。
