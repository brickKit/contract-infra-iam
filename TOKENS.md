[English](TOKENS.md) · [中文](TOKENS.zh.md)

# Tokens, keys and verification, iam/1.0

What an IAM member issues, how it publishes its keys, how a component verifies an access token, and how a member verifies the IdP token it is given. Shapes: [`schemas/access-token.schema.json`](schemas/access-token.schema.json), [`schemas/refresh-token.schema.json`](schemas/refresh-token.schema.json), [`schemas/jwks.schema.json`](schemas/jwks.schema.json), [`schemas/server-metadata.schema.json`](schemas/server-metadata.schema.json). Cases: [`vectors/`](vectors/README.md). The component side is also be-protocol P5; the two texts say the same, and this one adds the issuer side.

## Two kinds of token, never confused

| | IdP token | Platform token |
|---|---|---|
| Issued by | the IdP (Casdoor, Keycloak, a customer's IdP) | the installed IAM member |
| Audience | the IdP client id of the platform client | `TENANT_ID` |
| `sub` | the IdP's subject (Casdoor: its user UUID) | the platform user id, a UUIDv7 owned by the platform |
| Seen by | the browser, once, and the member's token exchange | every component, on every request |
| Verified by | the member only ("Subject token" below) | every component (be-protocol P5, "Verification" below) |

A component never accepts an IdP token, and a member never forwards one. Repro r1-09 showed why the separation needs no extra code: a Casdoor token has `aud` = its client id and no `typ` claim, so the component checks `aud` and `typ` each refuse it on their own (vector `AT-038`).

## Access token

Claims (issuer side; a verifier is more lenient, see "Verification"):

| Claim | Required | Value |
|---|---|---|
| `iss` | yes | `IAM_ISSUER` |
| `aud` | yes | `[TENANT_ID]`, an array whose first element is `TENANT_ID`; further audiences are reserved |
| `sub` | yes | the platform user id (UUIDv7), or `svc:<id>` for a service account (reserved) |
| `typ` | yes | `"access"` |
| `iat`, `nbf` | yes | issue time; `nbf` = `iat` |
| `exp` | yes | `iat` + the access TTL: default 600 s, at most 3600 s |
| `jti` | yes | a UUIDv7, unique per token |
| `tenant_id` | yes | `TENANT_ID` (one deployment is one tenant, F1); `org_id` is never emitted |
| `azp` | yes | the platform client: `pc`, `mobile`, …; `svc` for a service account |
| `roles` | when any | role codes from the authorization provider's `ResolveClaims`; never permission keys (0203) |
| `dept_path` | when any | from `ResolveClaims`, `/<id>/…/`; **omitted** when the user has no department, never `""` and never `"/"` (be-protocol P6.4) |
| `locale` | when known | BCP 47, for server-rendered text |
| `act` | delegation only | `{sub, kind, act?}` (RFC 8693 §4.1); `kind` is `user`, `svc` or `agent` (reserved, A4) |
| `ceil`, `dg` | delegation only | ceiling profile codes and the delegation id from the authorization provider's `CreateDelegation`; always together, always with `act` |

- Header: `alg` (`RS256`, `ES256` or `EdDSA`, the alg of the signing key), `kid`, `typ: "JWT"`. Verifiers ignore the header `typ`.
- **Fail-closed issuance**: `roles`, `dept_path` and `tenant_id` come from `ResolveClaims` at login and at every refresh. When it fails, the member answers `503 AUTHZ_UNAVAILABLE` and issues nothing; it never reuses older roles.
- Size: no permission keys, no profile data. A token stays well under 4 KiB.

## Refresh token

- Opaque to the frontend and to every component. A member MAY choose any format.
- When it is a JWT signed with a published key, it MUST match `refresh-token.schema.json`: `typ: "refresh"`, `aud: [IAM_ISSUER]` (never `TENANT_ID`), `sid` (the session id), `jti` (this token), `exp` no later than the session's end. A component's verifier then refuses it twice over: wrong `aud`, wrong `typ` (vector `AT-039`).
- **Rotation**: every refresh returns a new refresh token with a new `jti` and the same `sid`; the presented one is invalid at once.
- **Reuse detection**: presenting a refresh token that was already rotated revokes every token of its `sid` and answers `401 REFRESH_TOKEN_REUSED` (OAuth 2.0 Security BCP). There is no grace window; the frontend refreshes single-flight across tabs (LOGIN.md).
- **Absolute session end**: login time + `REFRESH_TOKEN_TTL_SECONDS` (default 7 days). Rotation never extends it.
- A member stores refresh tokens only as hashes.

## Issuer

- `IAM_ISSUER` is a **stable name of the deployment's platform issuer**, not a member's address: it stays the same when the member is swapped (DIRECTORY.md, "Switching members"). Recommended form `urn:be:<TENANT_ID>:iam`. It is never the member's service name and never the IdP's issuer.
- `IAM_URL` is the member's base URL by its own service name, written once in `config/vars.yaml` as `$endpoint:<member ID>` (like `AUTHZ_URL`, be-protocol P2.10). It changes with the member.
- **Server metadata** at `{IAM_URL}/.well-known/oauth-authorization-server`, the shape of RFC 8414 plus `be_contract`, `be_member`, `be_capabilities`, `be_tenant_id`. Because the issuer is a name and not a URL, the location is relative to `IAM_URL`, not to the issuer; this is the one deliberate departure from RFC 8414. Project network only.

## Signing keys

| Rule | |
|---|---|
| Where | `{IAM_URL}/.well-known/jwks.json`, where components fetch it (be-protocol P5.4); there is no separate address key. Project network only, never an edge route |
| Algorithms | `RS256` (RSA ≥ 2048 bit), `ES256` (P-256), `EdDSA` (Ed25519). No HMAC, no `none` |
| Every key | `kid` (unique, never reused; SHOULD be the RFC 7638 thumbprint), `alg`, `use: "sig"`, public members only |
| Keys published | 1 to 3: the current key; the previous key during a rotation; optionally the next key ahead of use |
| Rotation | publish the next key at least 1 h before signing with it (components cache the JWKS for at most 1 h, P5.4); after switching, keep the previous key published for at least the access TTL + 60 s; then remove it. The keys are files the member re-reads (be-protocol P2.9), so no restart is needed: (1) write the new private key to `APP_TOKEN_NEXT_SIGNING_KEY_FILE` and run `up`; every replica publishes its public key within 30 s; (2) at least 1 h later, write it to `APP_TOKEN_SIGNING_KEY_FILE`, clear the next key, run `up`; the member signs with it from then on; (3) the member records the public key of every key it has signed with, and when it stopped, in its own schema, and keeps publishing it for the access TTL + 60 s after that, across restarts and replicas |
| Caching | `Cache-Control: public, max-age` ≤ 3600 |
| Private keys | the secret files `APP_TOKEN_SIGNING_KEY_FILE` and `APP_TOKEN_NEXT_SIGNING_KEY_FILE` (`mount: file`; filled in `config/` with `file://` or `${VAR}`, or `existingSecret` on Kubernetes, where cert-manager or a similar tool may rotate them), never in the image, never in an environment variable, never logged |

Removing a key ends every access token signed with it; that is how a member switch ends the old member's tokens (DIRECTORY.md).

## Verification

How every component, in any language, verifies an access token. Normative for SDKs, locked by `vectors/tokens/access-token.json` (56 cases). Checks in this order; the first failure decides the answer.

| # | Check | Failure |
|---|---|---|
| 1 | `Authorization: Bearer <compact JWS>`, three base64url segments, header and payload JSON objects | 401 `TOKEN_INVALID` |
| 2 | header `alg` in {`RS256`, `ES256`, `EdDSA`}; `kid` present; the JWKS key with that `kid` exists (after at most one rate-limited refetch) and its `alg` equals the header's | 401 `TOKEN_INVALID` |
| 3 | signature verifies with that key | 401 `TOKEN_INVALID` |
| 4 | types: `roles`, `ceil` arrays of strings; `dept_path`, `tenant_id`, `azp`, `locale`, `dg` strings; `act` an object with non-empty `sub`, `kind` in {`user`, `agent`, `svc`}, nested `act` valid | 401 `TOKEN_INVALID` |
| 5 | `iss` = `IAM_ISSUER` | 401 `TOKEN_INVALID` |
| 6 | `aud` is a string or an array of strings, and contains `TENANT_ID` | 401 `TOKEN_INVALID` |
| 7 | `typ` = `"access"` (a missing `typ` fails) | 401 `TOKEN_INVALID` |
| 8 | `sub` a non-empty string | 401 `TOKEN_INVALID` |
| 9 | `exp` a number and `now < exp + 60` | 401 `TOKEN_INVALID` |
| 10 | `nbf`, if present, a number and `nbf ≤ now + 60` | 401 `TOKEN_INVALID` |
| 11 | `iat` a number and `iat ≤ now + 60` | 401 `TOKEN_INVALID` |
| 12 | `jti` a non-empty string | 401 `TOKEN_INVALID` |
| 13 | `stale_since[sub]` exists and `iat < stale_since[sub] − 5` | 401 `TOKEN_STALE`, `WWW-Authenticate: Bearer error="token_stale"` |
| 14 | `dg` is non-empty and a key of the bundle's `revoked_grants` | 401 `TOKEN_STALE`, `WWW-Authenticate: Bearer error="token_stale"` |
| 15 | the token is delegated (it has `act`, a non-empty `ceil` or a non-empty `dg`) while the bundle's `delegation` is false | 401 `UNSUPPORTED_DELEGATION` |
| 16 | along the `act` chain, outermost first: kind `agent` while `agents` is false; kind `user` (impersonation) while `impersonation` is false; kind `svc` needs nothing more | 401 `UNSUPPORTED_DELEGATION` |

- Checks 13–16 are contract-infra-authz `EVALUATION.md` E2, in its order: a stale delegated token answers `TOKEN_STALE`, so the frontend refreshes before anything else (be-protocol P5.5, P5.6, P6.2).
- Unknown claims are ignored. `org_id` is read, never used.
- Every failure has domain `be`. The detail of which check failed goes to the log, never to the response.
- **A JWT library is not enough**: no library checks `typ` or the claim types; some accept an `aud` array with non-string members or never check a future `iat` (vectors README, "Gaps"). The SDK adds these checks itself.

## Subject token

How a member verifies the IdP ID token presented to `POST /api/iam/token` (LOGIN.md). Locked by `vectors/tokens/subject-token.json` (27 cases). Failure is 401 `SUBJECT_TOKEN_INVALID` (domain `infra/iam`, `metadata.oauth_error = invalid_grant`).

| # | Check |
|---|---|
| 1–3 | compact JWS; `alg` in the member's allow-list ⊆ {`RS256`, `ES256`, `EdDSA`} and equal to the IdP JWKS key's `alg`; `kid` required; signature verifies against the IdP's JWKS (from IdP discovery `jwks_uri`, fetched on the project network) |
| 4 | `iss` = the IdP issuer as the browser sees it (discovery `issuer`), even when the member reaches the IdP by another address |
| 5 | `aud` (string or array) contains a trusted IdP client id (one per platform client); with several audiences `azp` is required; when `azp` is present it is a trusted client id (OIDC Core 3.1.3.7). The trusted client fixes the token's `azp` |
| 6 | `sub` non-empty |
| 7 | `now < exp + 60`; `iat` present, `iat ≤ now + 60`, and `now − iat ≤ max_age + 60` (max_age default 600 s); `nbf` if present |
| 8 | **not a refresh or access token of the IdP**: a `typ` claim, if present, equals `ID` (case-insensitive; Keycloak marks `Refresh` and `Bearer`); a `tokenType` claim, if present, is `access-token` or `id-token` (Casdoor marks `refresh-token`; its ID token and access token are the same JWT, repro r1-09) |
| 9 | **single use**: the same subject token (SHA-256 of the compact form) is exchanged at most once while it is unexpired; a second exchange fails |

- `nonce` is checked by the frontend, which created it; the member cannot.
- Casdoor's refresh token carries no `kid` (r1-09), so check 2 already refuses it; check 8 refuses it independently, so the outcome never depends on that accident (vectors `ST-020`, `ST-021`).

## Platform `sub`

- The member mints the platform `sub` (UUIDv7) at the first login of an IdP account it has never seen, and keeps `identity_links(sub, idp, idp_issuer, idp_sub, linked_at, method)`, one row per IdP account. The natural key is `(idp_issuer, idp_sub)`.
- Linking an IdP account to an existing platform user:

| `method` | When | Default |
|---|---|---|
| `exact` | the `(idp_issuer, idp_sub)` row exists | always |
| `first_login` | no row and no rule below matched: a new platform user | on, unless `IAM_AUTO_PROVISION=false`, then `403 ACCOUNT_NOT_LINKED` |
| `email` | no row; exactly one platform user has this e-mail, and the IdP says `email_verified: true` | **off**; a security risk, opt-in per deployment |
| `username` | no row; exactly one platform user has this login name and no link to this issuer yet, within a migration window | off; for a member switch only |
| `import`, `scim`, `admin` | rows written by an import, a SCIM push or an administrator | — |

- A `sub` is never reused, never changed, and survives a member switch through the export. Business data (`owner_id`, role assignments, audit) refers only to it.

## Bootstrap administrator

The platform `sub` exists only after a person's first login, so a deployer cannot name the first administrator by `sub`.

- Shared configuration key `BOOTSTRAP_ADMIN_LOGIN` (`config/vars.yaml`): the IdP login name, or an e-mail address, of the first administrator.
- At a login exchange, the member matches it case-insensitively against the IdP account's login name (`preferred_username`; Casdoor `name`), or against `email` when the IdP says `email_verified: true`. It binds at most once per deployment: the first match wins, the binding is stored, later matches change nothing.
- On binding, the member publishes the normal directory event with `bootstrap_admin: true` in its payload: `infra.iam.user.created.v1` when this is the person's first login, `infra.iam.user.updated.v1` when the person existed before the key was set. Authorization members grant their bootstrap administrator role on it, idempotently (contract-infra-authz). The roles appear in the token at the next refresh.
- The binding travels in the export (`user.bootstrap_admin`), so an importing member never binds a second person.
- An unset or empty key binds nobody. Changing the key after the binding has no effect; further administrators are granted in the authorization provider.
