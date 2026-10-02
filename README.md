[English](README.md) · [中文](README.zh.md)

# contract-infra-iam

The family contract of the IAM slot, version **iam/1.0**: what every identity member implements, and what SDKs, the frontend, the authorization members and the conformance suite consume. It holds contracts only: no member code, no logic.

## What this is

- **The provider contract** `infra.iam.v1`: the login configuration, the token exchange (RFC 8693) with its login profile and reserved delegation profile, refresh and logout, the access and refresh token shapes, the JWKS and issuer metadata, the platform-owned `sub` with its identity links, the directory events, the system-plane reads `IamProvider`, SCIM inbound, the capability enum, the error reasons, the NDJSON export, and token vectors that lock verification.
- **Not here**: how a component verifies a token at run time and answers a stale one (be-protocol P5, which cites this repository for the claims); what a person may do once identified (`contract-infra-authz`); the IdP servers themselves, which are infrastructure (`make up`, decision 0106).
- **Consumers**: the official SDKs (claims, `IAM_ISSUER` / `TENANT_ID` / `IAM_JWKS_URL`, `vectors/tokens/access-token.json`); the frontend (login-config, discovery, token endpoint, refresh, logout, capabilities); authorization members (`infra.iam.user.*` events for `stale_since` and the bootstrap administrator, departments when declared); components that show people (`BatchGetUsers`, `ListUsers`, user events); `tools/be-acceptance/conformance/iam/`.

## Members

| Member | Status | Declares (`provides_capabilities`) | Fits |
|---|---|---|---|
| `infra/iam-casdoor` (default) | 3.0.0 implements iam/1.0 | core, password_login, social_cn, mfa; ldap, saml as Casdoor is configured; directory_departments later | small and medium customers in China, one machine |
| `infra/iam-keycloak` | phase 06, second member | core, password_login, ldap, saml, mfa, directory_departments | Active Directory / LDAP federation, SAML, large enterprises (JVM memory) |
| generic OIDC + SCIM member | planned, third member | core, scim_inbound, directory_departments | a customer that brings Entra ID, Okta, Authentik or DingTalk unified identity |

`token_exchange_delegation` and `service_accounts` are **reserved**: shapes fixed here, no member declares them in 3.0.0. `act.kind = agent` is reserved by A4 and never issued.

## Layout

| Path | Holds |
|---|---|
| [`TOKENS.md`](TOKENS.md) | access and refresh tokens, issuer, signing keys, verification (component side), subject-token verification (member side), platform `sub`, bootstrap administrator |
| [`LOGIN.md`](LOGIN.md) | the browser flow, IdP discovery requirements, the token exchange profiles, refresh, logout, errors |
| [`DIRECTORY.md`](DIRECTORY.md) | platform users, events, departments, reads, SCIM inbound, export and switching members |
| `proto/infra/iam/v1/provider.proto` | gRPC service `IamProvider` |
| `openapi/iam.openapi.yaml` | the member REST surface (OpenAPI 3.1) |
| `openapi/extensions/` | member-specific paths (Casdoor webhook), [rules](openapi/extensions/README.md) |
| `schemas/` | access token, refresh token, JWKS, server metadata, login-config, tenant features, token response, IdP discovery requirements, export record |
| `examples/` | valid and invalid examples of every schema, Casdoor v4.1.0's real discovery document, an export file |
| `capabilities.yaml` | the capability enum: core vs optional, what a member must do, how its absence degrades |
| `errors.yaml` | the family's error reasons, domain `infra/iam` |
| `events/iam.events.json` | the directory and audit events |
| `vectors/` | token verification vectors, test keys, generator and independent cross-check ([README](vectors/README.md)) |
| `gen/go/infra/iam/v1` | generated Go package `iamv1` (committed) |
| `fs.go`, `go.mod` | the Go module `github.com/brickKit/contract-infra-iam`, which embeds the files above as `iamcontract.FS` |

## Addressing and planes

- **Shared keys** (`config/vars.yaml`): `IAM_URL` (the member's base URL by its own service name), `IAM_JWKS_URL` (= `{IAM_URL}/.well-known/jwks.json`), `IAM_ISSUER` (a stable name, recommended `urn:be:<TENANT_ID>:iam`; not an address and unchanged by a member switch), `TENANT_ID`, `BOOTSTRAP_ADMIN_LOGIN`. No component declares a dependency on an IAM member, and the IAM member declares none on an authorization member: it reaches it through `AUTHZ_URL` (0104, 0107).
- **Edge** (public unless noted): `/api/iam/login-config`, `/api/tenant/features`, `/api/iam/token`, `/api/iam/token/refresh`, `/api/iam/logout` (signed in), `/api/admin/iam/*` (key `infra.iam.admin`), `/scim/v2/*` (capability `scim_inbound`, SCIM secret).
- **Project network only**: `/.well-known/jwks.json`, `/.well-known/oauth-authorization-server`, the gRPC service on the member's `grpc` port (callers send `be-caller`), and member extensions such as `/api/iam/webhooks/casdoor`.
- **Member configuration** every member has, by these names: `APP_TOKEN_SIGNING_KEY_PEM` (secret), `APP_TOKEN_PREVIOUS_PUBLIC_KEY_PEM`, `APP_TOKEN_TTL_SECONDS` (600), `REFRESH_TOKEN_TTL_SECONDS` (604800), `IAM_AUTO_PROVISION` (true), `IAM_LINK_BY_EMAIL` (false), `IAM_CLIENTS` (the platform clients: `azp` → IdP client id). IdP connection keys are the member's own.

## Capabilities

- **Core** is not optional: login-config, tenant features, server metadata, JWKS with rotation, the login profile of the token exchange, refresh rotation with reuse detection, logout, platform `sub` with identity links, fail-closed roles from `ResolveClaims`, the user events, `BatchGetUsers`, `ListUsers`, export and import.
- **Optional**: `password_login`, `social_cn`, `ldap`, `saml`, `mfa` (what the IdP offers; the login page degrades by them), `scim_inbound`, `directory_departments`; reserved: `token_exchange_delegation`, `service_accounts`.
- **Negotiation**: at assembly, a member's `assembly.yaml` lists `provides_capabilities` and a component's `requires_capabilities` (same gate as authz); at run time, `GET /api/tenant/features` and the server metadata list what the running member offers.
- **Absence is explicit and tested**: an operation of an undeclared capability answers `501` / `UNIMPLEMENTED` with `CAPABILITY_UNAVAILABLE` (domain `be`) and `metadata.capability`, or the specific `400` named in `capabilities.yaml`.
- Names are append-only; consumers ignore names they do not know.

## Versioning

- `contract` is `iam/1.<minor>` (in login-config, tenant features, server metadata, the export header); the Go module and the repository tags are `v1.<minor>.<patch>` (`v`-tags only: this is not a brickKit component).
- **Minor** only adds: optional claims, capabilities, rpcs, endpoints, parameters, event subjects and payload fields, export kinds, error reasons, vectors for new rules. Nothing changes meaning; every new capability is optional.
- **Patch**: wording, examples, more vectors for existing rules.
- **Major** (`iam/2`) is a new proto package `infra.iam.v2`, module path `/v2`, new subjects `….v2`, served beside the old ones while both are installed.
- Gates: `buf breaking` (FILE) against the previous tag (`make breaking AGAINST=v1.0.0`); capability names, reasons, subjects and vector IDs are append-only.
- A member, an SDK or the suite pins one exact tag. be-protocol refers to the major only ("`iam/1`").

## Generated code

**Decision** (the same as contract-infra-authz): Go code is generated here and published by this module; every other language generates privately from a pinned tag.

| Language | What | Where |
|---|---|---|
| Go | `protoc-gen-go` v1.36.6 + `protoc-gen-go-grpc` v1.5.1 output, committed with the tag that changes the proto (`make gen`; `make gen-check` fails when it is stale) | `github.com/brickKit/contract-infra-iam/gen/go/infra/iam/v1` (package `iamv1`); the contract files through `iamcontract.FS` |
| Python, TypeScript | no package in 1.0; the one consumer in a process (the SDK, or a component until the SDK wraps `IamProvider`) copies `proto/`, `schemas/` and `vectors/` from a pinned tag, checks `vectors/SHA256SUMS`, and generates privately | inside that consumer |
| Frontend | its generator reads `openapi/iam.openapi.yaml` and `errors.yaml` from a pinned tag | the frontend repository |

- **One generated Go package per process is mandatory**: the protobuf runtime registers `infra.iam.v1.*` by full name, and two copies in one shell binary (the Casdoor member's server and a caller's client in `be/go-infra`) conflict at start. Go's minimal version selection gives one shell exactly one version of this module.
- The family contract no longer lives in the Casdoor member's repository (`contracts/infra/iam/v1` there, package `infra-iam-casdoor/gen/infra/iam`): with a second member it would make Keycloak depend on Casdoor's repository. 0101 gains "family contract packages" as a third kind of package that crosses a boundary (contract-infra-authz states the amendment; it applies to both families).
- When a second Python or TypeScript consumer can meet another in one process, this repository adds installable `python/` and `ts/` packages and the consumers switch in the same release.

## Proving conformance

Suite `tools/be-acceptance/conformance/iam/` (`iamconf`). It brings its own test OIDC provider that issues ID tokens (including refresh-marked and access-marked ones), or runs against the member's real IdP container.

1. Declare `provides_capabilities` in the member's `assembly.yaml`, and advertise the same set in tenant features and the server metadata.
2. Run the suite against the running member:
   - **core**: discovery of the IdP passes `idp-discovery.schema.json` and the PKCE checks of LOGIN.md; login-config, tenant features, metadata and JWKS match their schemas; an exchange with the RFC 8693 login profile returns a token that matches `access-token.schema.json`; every subject-token vector rejected by the member's endpoint as the vector says; a second use of one subject token fails; refresh as access refused by a fixture component; rotated refresh invalid at once and its reuse ends the session; during a key rotation both keys verify; the same IdP account twice gets the same `sub`; `BOOTSTRAP_ADMIN_LOGIN` binds once and the event carries `bootstrap_admin`; a disabled user's event within 30 s and the next exchange refused; export, import into a fresh member, same `sub` for the same IdP account; `ResolveClaims` down gives `503` and no token;
   - every declared optional capability passes its group (`login_methods`, `scim`, `directory`);
   - every undeclared one answers as `capabilities.yaml` says.
3. The suite writes a capability matrix into the member version's test record; `make gates` checks the record exists.
4. Every official SDK passes `vectors/tokens/access-token.json`; every member passes `vectors/tokens/subject-token.json` in its unit tests.

## Token vectors

78 cases (51 access token, 27 subject token), IDs stable and never reused. Written by `vectors/tools/gen.mjs` (Node `node:crypto`, verdicts by hand from TOKENS.md), cross-checked by `vectors/tools/check` (Go standard library, no JWT library, no shared code); both seen red on a corrupted vector before being trusted. A third run through `jose` 6 found two gaps of JWT libraries that the vectors now catch ([vectors/README.md](vectors/README.md)).

## Evidence

Repro r1-09 (2026-10-02, Casdoor v4.1.0, real Chromium): discovery is complete and declares S256; a public client completes authorization code + PKCE from the browser against discovery's endpoints; wrong or missing verifiers and reused codes are refused; Casdoor's ID token and access token are one JWT with `aud` = client id, no `typ` claim, `tokenType: access-token`; its refresh token is a JWT signed with the same key, without `kid`, `tokenType: refresh-token`; its own token exchange needs a client secret and returns Casdoor-shaped tokens. Each finding is a rule in TOKENS.md or LOGIN.md and a vector.

## Working on this repository

- `make check` = `lint` (buf) + `gen-check` + `build` (go vet, build, gofmt) + `vectors-check` + `validate` (JSON Schema, examples, export framing, events, capabilities, reasons, OpenAPI, issuer-shaped vectors), all in throwaway containers.
- A change goes in this order: proto / OpenAPI / schema → the prose (`TOKENS.md`, `LOGIN.md`, `DIRECTORY.md`) and its Chinese mirror → a case in `gen.mjs` and the checker → `make vectors` → `make check` → tag.
- Documents: English canonical, Chinese mirror `*.zh.md` beside each, same `##` sections.
