[English](DIRECTORY.md) · [中文](DIRECTORY.zh.md)

# Directory, events, export and switching members, iam/1.0

The platform's users as the IAM member holds them, how changes reach other components, how a customer's IdP pushes users in, and how the whole identity state moves to another member. Events: [`events/iam.events.json`](events/iam.events.json). Reads: [`proto/infra/iam/v1/provider.proto`](proto/infra/iam/v1/provider.proto). Export: [`schemas/export-record.schema.json`](schemas/export-record.schema.json), example [`examples/export.ndjson`](examples/export.ndjson).

## Platform users

- The member holds one row per platform user: `sub`, `status` (`active` | `disabled`), `username`, `display_name`, `email`, `email_verified`, `phone`, `locale`, `im_accounts`, `version`, plus the identity links (TOKENS.md, "Platform `sub`").
- The profile is copied from the IdP at every login and at every directory change the member learns of; the IdP stays the source of profile data, the member the source of `sub` and `status`.
- **Disabling** (at the IdP, by SCIM `active=false`, or by an administrator): in one transaction the member sets `status = disabled`, revokes every refresh token of the `sub` and writes `infra.iam.user.disabled.v1` to its outbox; the event is published within 30 s of the member learning of the change. Authorization members consume it and set `stale_since[sub]`, so access tokens already issued fail within one bundle poll (about 15 s, be-protocol P6.1) instead of at expiry.
- **Deleting** is erasure: the member drops the profile and the identity links, keeps the bare `sub` so it is never reused, and publishes `infra.iam.user.deleted.v1`; consumers erase what they hold for the `sub`.
- Roles and departments used for decisions are not here: they come from the authorization provider through `ResolveClaims`.

## How a member learns of changes

Its own business, never part of the family surface:

| Member | Mechanism |
|---|---|
| `infra/iam-casdoor` | Casdoor webhooks to `POST /api/iam/webhooks/casdoor` (member extension); every delivery only says who changed, the member re-reads Casdoor, so arrival order never matters; a periodic reconcile catches lost deliveries |
| `infra/iam-keycloak` | polls Keycloak's admin events |
| generic OIDC + SCIM member | SCIM 2.0 inbound (below) plus the profile in each ID token |

## Events

All state mode (foundations 13): each payload is the aggregate's whole state at `ce-aggregateversion`, so a consumer that skips or reorders versions still converges.

| Subject | Aggregate | Payload | Capability |
|---|---|---|---|
| `infra.iam.user.created.v1` | `infra.iam.user` (`ce-subject` = `sub`) | user state; `bootstrap_admin: true` on the binding event | core |
| `infra.iam.user.updated.v1` | `infra.iam.user` | user state (also re-enabling) | core |
| `infra.iam.user.disabled.v1` | `infra.iam.user` | user state, `status: disabled` | core |
| `infra.iam.user.deleted.v1` | `infra.iam.user` | `{sub, status: deleted, deleted_at}`; the final version | core |
| `infra.iam.department.{created,updated,deleted}.v1` | `infra.iam.department` (`ce-subject` = `department_id`) | department state | `directory_departments` |
| `infra.iam.membership.changed.v1` | `infra.iam.user_membership` (`ce-subject` = `sub`) | the complete set of the user's memberships | `directory_departments` |
| `infra.iam.login.v1` | `infra.iam.session` (`ce-subject` = `sid`) | audit only | core, peripheral |
| `infra.iam.impersonation.started.v1` | `infra.iam.delegated_session` | reserved (A5) | `token_exchange_delegation` |

- `ce-source` is the member's component ID; `ce-dataschema` is `contract-infra-iam@<tag>/events/iam.events.json#<subject>`. The subjects belong to the family: every member publishes the same ones, so no consumer changes when the member is swapped.
- User state: `sub`, `status`, `display_name` (required), `username`, `email`, `email_verified`, `phone` (E.164), `locale`, `im_accounts[{channel, account_id}]`. No tokens, no secrets, no IdP subject.
- Membership is its own aggregate with its own version, so a profile change and a membership change never race.

## Departments from the directory (`directory_departments`)

- Many IdPs hold an organisation tree (Casdoor groups, Keycloak groups, SCIM Groups, DingTalk departments). A member that declares `directory_departments` mints a platform `department_id` (UUIDv7) for each, keeps `department_link(department_id, idp_issuer, idp_group_id)`, and publishes the department and membership events.
- **These events report the IdP's tree; they do not by themselves define the platform's department tree** (the one `dept_path` is built from). Which component owns that tree is settled in mdm/org's design (P2). Until then the authorization provider owns it (`user_dept` in contract-infra-authz) and MAY consume these events to sync it.
- Without the capability, `ListDepartments` and `ListMemberships` answer `UNIMPLEMENTED` / `CAPABILITY_UNAVAILABLE`, and departments are managed only in the authorization provider.

## Reads (system plane)

`infra.iam.v1.IamProvider` on the member's `grpc` port, reached through the shared key `IAM_GRPC_URL` (`$endpoint:<member ID>:grpc` in `config/vars.yaml`, be-protocol P2.10; never a dependency edge, and the port is whatever the member declares), with `be-caller`. A caller declares `IAM_GRPC_URL` optional: when the member does not run the key is absent and the caller shows a `sub` without its name until it can read it:

| rpc | Use | Limit |
|---|---|---|
| `BatchGetUsers` | display names and contacts for a list of `sub`s (the only legal way, no N+1) | 500 subs; unknown subs omitted; deleted users omitted |
| `ListUsers` | backfill a user snapshot before following the events (be-protocol P15) | page ≤ 500, opaque cursor, ordered by `(updated_at, sub)` |
| `ListDepartments`, `ListMemberships` | the same for departments, capability `directory_departments` | page ≤ 500 |

There is no "get user by IdP subject": the IdP subject never leaves the member.

## SCIM inbound (`scim_inbound`)

For a customer whose IdP (Entra ID, Okta, Authentik, DingTalk unified identity) provisions users by push.

- Endpoints under `/scim/v2/`: `Users`, `Groups` (with `directory_departments`), `ServiceProviderConfig`, `Schemas`, `ResourceTypes` (RFC 7643, RFC 7644). Edge routes, authenticated by the member's SCIM bearer secret (a secret configuration key, delivered as a `…_FILE` file and re-read when it changes, be-protocol P2.9), compared in constant time; never by a platform token.
- A pushed user becomes a platform user with an identity link of method `scim` keyed by the SCIM `externalId` (or `id`) under the pushing IdP's issuer; when that person later signs in through OIDC, the member links the ID token's `(iss, sub)` to the same platform user by the configured SCIM-to-OIDC attribute (default: `userName` = `preferred_username`).
- `active: false` disables; `DELETE` disables (erasure is an administrator action, not a SCIM side effect).

## Switching members

The export carries everything a new member needs to keep every `sub`.

| Step | |
|---|---|
| 1 | Export from the old member: `GET /api/admin/iam/export` (key `infra.iam.admin`), format `iam-export/1` |
| 2 | Move the people into the new IdP the way that IdP supports (Keycloak's partial import can keep each user's id; a customer IdP already has them) |
| 3 | Import into the new member: `POST /api/admin/iam/import?dry_run=true`, then without `dry_run`. Identity links to the old IdP are kept (they no longer match logins, and allow switching back). For the new IdP, either import pre-mapped `identity_link` rows (`method: import`), or open the `username` link window (TOKENS.md) for the first login of each person |
| 4 | `brickkit add` the new member, `brickkit remove` the old one; point `IAM_URL` and `IAM_GRPC_URL` in `config/vars.yaml` at the new member (`$endpoint:<new member ID>` and `$endpoint:<new member ID>:grpc`, two lines). `IAM_ISSUER` and `TENANT_ID` do not change |
| 5 | People sign in again: the old member's keys are gone from the JWKS. Run `iamconf` against the new member |

**Format `iam-export/1`**: UTF-8 NDJSON, LF, no blank lines; first line `header` (`format`, `contract`, `member`, `exported_at`, `tenant_id`, `issuer`, `kinds`), last line `footer` (`counts` per kind, `sha256` of every line between them with its LF); records grouped in the order `user`, `identity_link`, `department_link`, `department`, `membership`, each sorted by its natural key, so two exports of one state differ only in `exported_at`. Same framing as `authz-export/1`.

**Import rules**: one transaction, all or nothing. Refused (`400 IMPORT_INVALID`) when the header's `tenant_id` differs from `TENANT_ID`, the contract major is not `iam/1`, or the footer does not match. Stops at the first conflict (`409 IMPORT_CONFLICT` with the line): an `(idp_issuer, idp_sub)` already linked to another `sub`, or a `sub` whose existing row disagrees. A kind missing from the header is "not carried over", never "empty". User versions continue above the imported ones, so consumers' cursors stay valid. The importer publishes no `created` events for imported users (the consumers already know them).
