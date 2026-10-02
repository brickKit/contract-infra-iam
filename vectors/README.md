[English](README.md) · [中文](README.zh.md)

# Token vectors, iam/1.0

Language-neutral test cases for the two token checks of the IAM family. Every official SDK runs `tokens/access-token.json` in its unit tests (be-protocol P5); every IAM member runs `tokens/subject-token.json`. The rules are in [../TOKENS.md](../TOKENS.md); when a vector and the text disagree, the text wins and the vector is fixed in a patch release.

## Files

| File | Cases | What is checked |
|---|---|---|
| `tokens/access-token.json` | 51 (`AT-…`) | a component verifying a platform access token: format, `alg` allow-list and key match, `kid`, signature, claim types, `iss`, `aud`, `typ`, `sub`, `exp`/`nbf`/`iat` with skew, `jti`, delegation against bundle capabilities, stale |
| `tokens/subject-token.json` | 27 (`ST-…`) | a member verifying the IdP ID token given as `subject_token`: the same JWS checks, IdP `iss`, trusted `aud`/`azp`, age, refresh and access markers of Casdoor and Keycloak |
| `keys/*.private.jwk.json` | 7 | **test keys, published on purpose**; never use them anywhere else |
| `SHA256SUMS` | — | `sha256sum -c` format over `tokens/` and `keys/`; SDKs that copy the vectors check it |
| `tools/gen.mjs` | — | the generator (Node 24, `node:crypto` only) |
| `tools/check/` | — | the independent cross-check (Go standard library only, no JWT library) |

## Case format

```json
{
  "format": "iam-vectors/1",
  "kind": "access_token_verification",
  "defaults": { "now": 1790000000, "issuer": "…", "tenant_id": "…", "skew_seconds": 60, "jwks": { "keys": [] } },
  "cases": [
    { "id": "AT-010", "name": "typ refresh is refused", "token": "<compact JWS>", "context": {},
      "expect": { "valid": false, "status": 401, "reason": "TOKEN_INVALID", "domain": "be", "rule": "typ" } }
  ]
}
```

- The effective context is `defaults` with the case's `context` applied on top, key by key (shallow).
- Compare `valid`; when false also `status`, `reason`, `domain`; when true the identity fields given (`sub`, `act_sub`, `idp_sub`, `client_id`). `rule` names the failing check for debugging only. Most cases have exactly one fault; the precedence cases (`AT-049`, `AT-050`) fix the order TOKEN_INVALID → UNSUPPORTED_DELEGATION → TOKEN_STALE.
- No case needs the network or a clock: `now` is given, and an unknown `kid` is unknown after the one refetch.
- The access-token JWKS holds four keys so one file covers RS256, ES256 and EdDSA plus a rotation; a real JWKS holds at most three.
- ES256 signatures are randomised, so regenerating changes those tokens and `SHA256SUMS`. Regenerate only when cases change, in the same commit as the change.

## How the vectors were checked

1. `make vectors` writes the files with `gen.mjs`; the expected verdicts in it are written by hand from TOKENS.md.
2. `make vectors-check` runs `tools/check`, a second implementation of TOKENS.md written without any JWT library. Release rule: every case agrees, and `SHA256SUMS` verifies.
3. Before 1.0.0 the vectors were also run through `jose` 6 (the JWT library of the TypeScript stack) plus the contract's extra rules: 76 of 78 agree with the library's own checks; the two that do not are the gaps below.

## Gaps of JWT libraries the vectors catch

A verifier that only calls its library's verify function is not conformant. Found while cross-checking:

| Case | Rule | What common libraries do |
|---|---|---|
| `AT-011`, `AT-012` | `typ` must be `access` | no library checks a `typ` claim; it is the contract's own rule |
| `AT-017` | every `aud` element is a string | `jose` 6 accepts `[TENANT_ID, 7]` because it only searches for the expected value |
| `AT-023` | `iat` not later than `now + skew` | `jose` 6 checks `iat` only with `maxTokenAge`; golang-jwt v5 only with `WithIssuedAt()` |
| `AT-028`, `AT-029`, `AT-044`, `AT-045` | types of `roles`, `dept_path`, `act` | never checked by libraries (be-protocol P5.9) |
| `AT-019`, `AT-051` | `now < exp + skew` | libraries agree (equality is expired); a hand-written `now > exp + skew` is off by one |
| `ST-004`, `ST-006` | `azp` with several audiences | OIDC Core 3.1.3.7; not checked by libraries |
| `ST-021`, `ST-023`, `ST-024` | IdP refresh and access tokens refused by their markers | IdP-specific claims (`tokenType`, Keycloak `typ`) that no library knows |
