[English](README.md) · [中文](README.zh.md)

# Member-specific extensions

Paths one member serves for its own IdP and no other member has: webhook bridges, polling hooks. They are part of that member's implementation, listed here so that the family's path space stays collision-free.

| Rule | |
|---|---|
| Prefix | `/api/iam/webhooks/<member short name>` for inbound callbacks from the IdP; `/_iam/<member short name>/…` for anything else |
| Edge | never an edge route; the IdP reaches the member on the project network by the member's own service name |
| Callers | the member's IdP only; never a component, never the frontend |
| Authentication | a shared secret (a member secret key, delivered as a `…_FILE` file, be-protocol P2.12) or a signature the IdP supports, compared in constant time; never a platform token. The address the member hands to the IdP comes from a key filled with a reference to the member itself (`$endpoint:<member ID>/<extension path>`) |
| Effect | only through the family surface: a webhook makes the member re-read the IdP and publish `infra.iam.*` events; it never answers with directory data |
| Conformance | not covered by `iamconf`; each member tests its own extension |

| Member | File | Paths |
|---|---|---|
| `infra/iam-casdoor` | [infra-iam-casdoor.openapi.yaml](infra-iam-casdoor.openapi.yaml) | `POST /api/iam/webhooks/casdoor` |
| `infra/iam-keycloak` (planned) | — | none: it polls Keycloak's admin events |
| generic OIDC + SCIM member (planned) | — | none: SCIM inbound is a family capability (`scim_inbound`) |
