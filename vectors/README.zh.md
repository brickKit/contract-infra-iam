[English](README.md) · [中文](README.zh.md)

# token 向量，iam/1.0

IAM 族两项 token 检查的语言中立用例。每个官方 SDK 在单元测试里跑 `tokens/access-token.json`（be-protocol P5）；每个 IAM 成员跑 `tokens/subject-token.json`。规则在 [../TOKENS.zh.md](../TOKENS.zh.md)；向量与正文不一致时以正文为准，向量在 patch 版本里修正。

## 文件

| 文件 | 用例 | 检查什么 |
|---|---|---|
| `tokens/access-token.json` | 56 条（`AT-…`） | 组件验平台 access token：格式、`alg` 白名单与钥匙一致、`kid`、签名、claim 类型、`iss`、`aud`、`typ`、`sub`、带容差的 `exp`/`nbf`/`iat`、`jti`、对照 bundle 能力（`delegation`、`agents`、`impersonation`）的委托、stale 与已撤销的授权 |
| `tokens/subject-token.json` | 27 条（`ST-…`） | 成员验作为 `subject_token` 交上来的 IdP ID token：同样的 JWS 检查、IdP 的 `iss`、受信任的 `aud`/`azp`、年龄、Casdoor 和 Keycloak 的 refresh / access 标记 |
| `keys/*.private.jwk.json` | 7 把 | **测试钥匙，故意公开**；不得用在任何别的地方 |
| `SHA256SUMS` | — | `sha256sum -c` 格式，覆盖 `tokens/` 和 `keys/`；拷贝向量的 SDK 要核对它 |
| `tools/gen.mjs` | — | 生成器（Node 24，只用 `node:crypto`） |
| `tools/check/` | — | 独立交叉校验（只用 Go 标准库，不用任何 JWT 库） |

## 用例格式

```json
{
  "format": "iam-vectors/1",
  "kind": "access_token_verification",
  "defaults": { "now": 1790000000, "issuer": "…", "tenant_id": "…", "skew_seconds": 60, "jwks": { "keys": [] } },
  "cases": [
    { "id": "AT-010", "name": "typ refresh is refused", "token": "<紧凑 JWS>", "context": {},
      "expect": { "valid": false, "status": 401, "reason": "TOKEN_INVALID", "domain": "be", "rule": "typ" } }
  ]
}
```

- 实际上下文 = `defaults`，再逐键套上该用例的 `context`（浅合并）。
- 比较 `valid`；为 false 时再比 `status`、`reason`、`domain`；为 true 时比给出的身份字段（`sub`、`act_sub`、`idp_sub`、`client_id`）。`rule` 只说明哪一项检查失败，供排错用，不比较。多数用例恰好一个缺陷；优先级用例（`AT-049`、`AT-050`、`AT-056`）锁定顺序 TOKEN_INVALID → TOKEN_STALE → UNSUPPORTED_DELEGATION（contract-infra-authz E2）。
- 没有用例需要网络或时钟：`now` 已给定，不认识的 `kid` 在一次重新拉取后仍不认识。
- access-token 的 JWKS 有四把钥匙，好让一个文件覆盖 RS256、ES256、EdDSA 外加一次轮换；真实的 JWKS 最多三把。
- ES256 签名带随机数，所以重新生成会改变这些 token 和 `SHA256SUMS`。只在用例变化时重新生成，并与那次改动同一个提交。

## 向量是怎么校验的

1. `make vectors` 用 `gen.mjs` 写出文件；其中的期望结论按 TOKENS 手写。
2. `make vectors-check` 跑 `tools/check`：不借助任何 JWT 库、按 TOKENS 写的第二份实现。发版规则：每条都一致，且 `SHA256SUMS` 校验通过。
3. 1.0.0 之前还用 `jose` 6（TypeScript 栈的 JWT 库）加契约自己的额外规则跑了一遍：78 条里 76 条与库自身的检查一致；不一致的两条就是下面的缺口。

## 向量能抓到的 JWT 库缺口

只调用库的 verify 函数的验签方不符合契约。交叉校验时发现：

| 用例 | 规则 | 常见库的行为 |
|---|---|---|
| `AT-011`、`AT-012` | `typ` 必须是 `access` | 没有库检查 `typ` claim；这是契约自己的规则 |
| `AT-017` | `aud` 的每个元素都是字符串 | `jose` 6 接受 `[TENANT_ID, 7]`，因为它只查期望值在不在 |
| `AT-023` | `iat` 不晚于 `now + skew` | `jose` 6 只在设了 `maxTokenAge` 时查 `iat`；golang-jwt v5 只在 `WithIssuedAt()` 时查 |
| `AT-028`、`AT-029`、`AT-044`、`AT-045` | `roles`、`dept_path`、`act` 的类型 | 库从不检查（be-protocol P5.9） |
| `AT-019`、`AT-051` | `now < exp + skew` | 库一致（等于即过期）；手写成 `now > exp + skew` 会差一秒 |
| `ST-004`、`ST-006` | 多个受众时的 `azp` | OIDC Core 3.1.3.7；库不检查 |
| `ST-021`、`ST-023`、`ST-024` | 凭标记拒收 IdP 的 refresh 与 access token | IdP 专有的 claim（`tokenType`、Keycloak 的 `typ`），库都不认识 |
