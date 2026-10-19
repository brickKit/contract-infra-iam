# contract-infra-iam

身份的族契约：每个身份成员（`infra/iam-casdoor`、`infra/iam-keycloak`）都要遵守的对外约定。旧版本（1.0.0 的预发布 rc.2）在分支 `legacy/v1`，标签保留；本主分支按终局设计从零开始（D59），版本从 `3.0.0` 起（A110）。

依据：装配项目 [be-assembly-standard](https://github.com/brickKit/be-assembly-standard) 的安全 02（可信身份）、03（外部身份源）、09a（账号状态的记录）、11（身份成员切换），协议 20（登录与会话），组件协议 [be-protocol](https://github.com/brickKit/be-protocol) 第 06 章（事件）与第 08 章（P8.1–P8.3，凭据的核验）。

## 范围

身份成员没有系统面方法：凭据经用户面签发、经公开的公钥集合核验，组件之间不为身份互相调用。所以这个契约里没有 protobuf，也没有生成的代码。契约由两部分组成：

| 部分 | 是什么 |
| --- | --- |
| 签发的凭据 | 组件按 P8.1 核验的访问凭据，以及取得公钥的地址；凭据的格式是 be-protocol 的规则，见下文“凭据” |
| 事件 | `infra.iam.account_status_changed.v1`：账号状态的变化，授权组件据此在视图里标出停用的账号（`accounts_disabled`） |

登录、刷新、登出与会话是协议 20 的用户面，各成员用自己的 OpenAPI 描述，不在这里。补取（来源水位的族契约，协议 02）留到底层阶段。

## 凭据

身份成员签发的访问凭据必须能通过 P8.1 的核验（向量 `jwt-verify`）：

- 格式与算法：JWS 紧凑格式，`typ` 为 `at+jwt`，带 `kid`，`alg` 只用 `RS256`、`ES256` 或 `EdDSA`。
- 声明：
  - `iss` 等于部署配置的签发方（`IAM_ISSUER`）；
  - `aud` 含 `be:deployment:<DEPLOYMENT_ID>`；
  - `sub` 是平台主体，即小写 UUIDv7，不是外部身份源的 subject；
  - 带 `exp`、`iat`。
  - 角色、部门等声明一律不放：授权只来自授权视图。
- 公钥：在一个公开地址提供标准的 JWKS 文档，组件只从配置的 `IAM_JWKS_URL` 取。轮换时新旧密钥并存，至少等组件的缓存（最长 1 小时，P8.2）过去，才撤下旧密钥。

## 事件 `infra.iam.account_status_changed.v1`

| 项 | 约定 |
| --- | --- |
| 流 | `infra.iam`，1 个分区（P6.1） |
| 记录身份 | 账号的平台主体；投影语义 `full`，记录版本等于记录的修订值 |
| 载荷 | 一条 `be.security.account_status` 记录的规范 JSON 字节（安全 09a；schema：be-protocol 的 `schemas/security/be.security.account_status.schema.json`），`authority` 是发出的身份成员 |
| 什么时候发 | 成员发现某个账号的状态或安全标记变了（停用、冻结、重新启用、解冻）时发一条。修订在成员自己的库里分配，带纪元与成员实例（协议 14） |
| 消费者 | 授权组件：按协议 02 的接收规则应用，旧修订不覆盖新修订 |

外部身份源给不出可靠的变更序号时，成员靠定期全量比较账号状态来发现变化（安全 03 的外部身份源），事件只是发现之后的通知。所以“账号在外部被停用”到“授权视图标出它”之间的延迟，等于比较的间隔加上事件与视图核验的时间。这段延迟要由成员写进自己的文档（`BRICKKIT.md`），不能说成“立即生效”。

## 版本

标签 `v3.0.0-alpha.N`。改凭据或事件的约定要升版本；事件的载荷只做加法，不兼容的变化换新的主版本类型（`.v2`）。
