[English](LOGIN.md) · [中文](LOGIN.zh.md)

# Login, token exchange, refresh and logout, iam/1.0

The flow between the browser, the IdP and the IAM member, and the token endpoint's profiles. Paths: [`openapi/iam.openapi.yaml`](openapi/iam.openapi.yaml). Shapes: [`schemas/login-config.schema.json`](schemas/login-config.schema.json), [`schemas/idp-discovery.schema.json`](schemas/idp-discovery.schema.json), [`schemas/token-response.schema.json`](schemas/token-response.schema.json). Verified against Casdoor v4.1.0 in a real browser (repro r1-09).

## The flow

| # | Who | What |
|---|---|---|
| 1 | browser → member | `GET /api/iam/login-config?client=pc` and `GET /api/tenant/features` (both public, before sign-in) |
| 2 | browser → IdP | `GET {discovery_url}`; take `authorization_endpoint`, `token_endpoint`, `end_session_endpoint` from it; check its `issuer` equals `idp.issuer` |
| 3 | browser → IdP | redirect to `authorization_endpoint` with `response_type=code`, `client_id`, `redirect_uri`, `scope` (from login-config), `state`, `nonce`, `code_challenge` (S256 of a 32-byte random verifier), `code_challenge_method=S256`, plus `extra_authorize_params` |
| 4 | IdP → browser | the person signs in at the IdP's own page; redirect back with `code` and `state` |
| 5 | browser → IdP | `POST token_endpoint`, form: `grant_type=authorization_code`, `client_id`, `code`, `redirect_uri`, `code_verifier`. No client secret: the client is public |
| 6 | browser | check `state` (step 3) and the ID token's `nonce`; keep the ID token in session storage only as the `id_token_hint` for logout; drop everything else the IdP returned |
| 7 | browser → member | `POST /api/iam/token`, login profile below; receive the platform access token and refresh token |
| 8 | browser → components | `Authorization: Bearer <platform access token>` |

- **No vendor path anywhere**: the frontend knows `idp.issuer`, `idp.client_id` and `discovery_url` only. Casdoor's endpoints happen to be `/login/oauth/authorize` and `/api/login/oauth/access_token`, its JWKS `/.well-known/jwks` without `.json`: only discovery can tell.
- `scope` never contains `offline_access`: the platform session is the member's refresh token, and an IdP refresh token in the browser is pure exposure.
- **Security comes from PKCE, not CORS.** r1-09 found that Casdoor rejects a preflight from an unknown origin but echoes any `Origin` on the form-encoded token POST (a simple request has no preflight). The protection is that a code is useless without its verifier, and a code is single-use; both were verified.

## IdP discovery

A member conforms only if its IdP publishes, at `{issuer}/.well-known/openid-configuration` (schema `idp-discovery.schema.json`):

| Member | Required |
|---|---|
| `issuer`, `authorization_endpoint`, `token_endpoint`, `jwks_uri` | yes |
| `response_types_supported` containing `code` | yes |
| `code_challenge_methods_supported` containing `S256` | yes |
| `id_token_signing_alg_values_supported` with one of `RS256`, `ES256`, `EdDSA` | yes |
| `end_session_endpoint` | optional; login-config says `end_session_supported` |

And the IdP must, for a public client registered with an exact redirect URI: redeem a code only with the right `code_verifier`; refuse a code issued without a challenge unless the client authenticates; redeem each code once. `iamconf` checks all of it against the real IdP container. Casdoor v4.1.0 passes (r1-09, cases 1–5 of `flow.py`).

## Token exchange

`POST /api/iam/token`, `application/x-www-form-urlencoded`, public. Answers `200` with `token-response.schema.json` and `Cache-Control: no-store`.

### Login profile (core)

| Parameter | Value |
|---|---|
| `grant_type` | `urn:ietf:params:oauth:grant-type:token-exchange` |
| `subject_token` | the IdP's ID token |
| `subject_token_type` | `urn:ietf:params:oauth:token-type:id_token` |
| `requested_token_type` | optional; only `urn:ietf:params:oauth:token-type:access_token` |
| `audience` | optional; must equal `TENANT_ID` |
| `client_id` | optional platform client (`pc`); must match the client the ID token was issued to |

The member, in order: verifies the subject token (TOKENS.md, "Subject token"); finds or creates the platform user (TOKENS.md, "Platform `sub`") and binds `BOOTSTRAP_ADMIN_LOGIN` if it matches; refuses a disabled user (`403 ACCOUNT_DISABLED`); calls the authorization provider's `ResolveClaims(sub)` through `AUTHZ_URL`; signs the access token; starts a session (`sid`) with a refresh token; publishes `infra.iam.login.v1`. The answer carries `access_token`, `issued_token_type = urn:ietf:params:oauth:token-type:access_token`, `token_type = Bearer`, `expires_in`, `refresh_token`, `refresh_expires_in`.

### Delegation profile (reserved, capability `token_exchange_delegation`)

Shapes fixed now so that adding them later is additive (A4, A5); no member builds them in 3.0.0.

| Case | Parameters | Result |
|---|---|---|
| Impersonation, read-only (A5) | `subject_token` = the administrator's platform access token, `subject_token_type = …:access_token`, `requested_subject` = the platform `sub` to act as, `reason` | the member calls `CreateDelegation(from_sub = requested_subject, to = {sub: admin, kind: user}, mode = act_as, profiles = [the read-only impersonation profile], valid_until ≤ now + 15 min)` at the authorization provider, which checks the key `infra.authz.impersonate`; the token has `sub` = the person, `act = {sub: admin, kind: user}`, `ceil`, `dg`, `exp` ≤ the delegation's end, **no refresh token**; `infra.iam.impersonation.started.v1` tells the person |
| Agent (A4) | `subject_token` = the user's access token, `actor_token` = the agent's credential, `actor_token_type` | never built in iam/1.0; `act.kind = agent` |
| Chained | a `subject_token` that already has `act` | the new `act` nests the old one: `{sub: new actor, kind, act: previous act}` (RFC 8693 §4.1) |

A member without the capability, and every member for `actor_token` in iam/1.0, answers `401 UNSUPPORTED_DELEGATION` (domain `be`, code `UNAUTHENTICATED`, as everywhere in be-protocol). Delegation "on behalf" (an approver's deputy) needs no exchange at all: the deputy uses their own token and the authorization provider's bundle carries the delegation (contract-infra-authz).

### Client credentials (reserved, capability `service_accounts`)

`grant_type=client_credentials` with `client_assertion_type = urn:ietf:params:oauth:client-assertion-type:jwt-bearer` and a `client_assertion` signed by the service account's key (RFC 7523). Token: `sub = svc:<id>`, `azp = svc`, roles from `ResolveClaims("svc:<id>")`, no refresh token. Without the capability: `400 UNSUPPORTED_GRANT_TYPE`.

## Refresh

`POST /api/iam/token/refresh`, form `grant_type=refresh_token&refresh_token=…`, public (the refresh token authenticates itself).

- Rotates (TOKENS.md, "Refresh token"); resolves roles again through `ResolveClaims`, so a refreshed token always carries current roles.
- `503 AUTHZ_UNAVAILABLE` does not consume the refresh token: retry it later.
- `401 REFRESH_TOKEN_INVALID`: unknown, expired, revoked, past the session end, or the user is disabled. `401 REFRESH_TOKEN_REUSED`: the session was closed for safety.
- **Single-flight in the frontend**: one refresh at a time across tabs (Web Locks API, `navigator.locks.request("be-iam-refresh", …)`), the others wait for its result. Two tabs refreshing with the same token would trip reuse detection.
- A `401 TOKEN_STALE` from a component (be-protocol P5.6) is answered by one refresh and one retry.

## Logout

`POST /api/iam/logout`, form `refresh_token=…`, `Authorization: Bearer <access token>`.

- Revokes every refresh token of the session, if the session belongs to the caller's `sub`. `200` also for an unknown or already revoked token (RFC 7009).
- Access tokens already issued remain valid until they expire (at most the access TTL); revocation of a person is the disabled event plus `stale_since` (DIRECTORY.md).
- When `end_session_supported`, the frontend then navigates to the IdP's `end_session_endpoint` with `id_token_hint` (kept at step 6) and `post_logout_redirect_uri`, so the IdP's own session ends too. Verified with Casdoor (r1-09, case 14).

## Errors

Every failure is problem+json (be-protocol P4) with a reason of domain `infra/iam` ([`errors.yaml`](errors.yaml)) or a reserved reason of domain `be`. On the three token paths `metadata.oauth_error` carries the RFC 6749 §5.2 code, so an OAuth-aware client can map it; there is no top-level `error` member (P4.1).

| Status | Reason | `oauth_error` | When |
|---|---|---|---|
| 400 | `INVALID_REQUEST` | `invalid_request` | a parameter missing or malformed |
| 400 | `UNSUPPORTED_GRANT_TYPE` | `unsupported_grant_type` | another `grant_type` (or a reserved one the member lacks) |
| 400 | `UNSUPPORTED_TOKEN_TYPE` | `invalid_request` | another `subject_token_type` |
| 400 | `INVALID_TARGET` | `invalid_target` | `audience` ≠ `TENANT_ID` |
| 401 | `UNSUPPORTED_DELEGATION` (be) | `invalid_request` | a delegation request the member does not support |
| 401 | `SUBJECT_TOKEN_INVALID` | `invalid_grant` | any check of TOKENS.md "Subject token", including a second use |
| 401 | `REFRESH_TOKEN_INVALID`, `REFRESH_TOKEN_REUSED` | `invalid_grant` | refresh |
| 403 | `ACCOUNT_NOT_LINKED` | `invalid_grant` | unknown IdP account and auto-provisioning off |
| 403 | `ACCOUNT_DISABLED` | `invalid_grant` | the platform user is disabled |
| 503 | `IDP_UNAVAILABLE` | `temporarily_unavailable` | the IdP's JWKS never loaded |
| 503 | `AUTHZ_UNAVAILABLE` | `temporarily_unavailable` | `ResolveClaims` failed (issuance is fail-closed) |
