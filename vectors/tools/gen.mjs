// Generator of the token vectors of contract-infra-iam (vectors/README.md).
//
// Node 24, no dependencies: node:crypto signs RS256, ES256 and EdDSA.
// Run from the repository root:  node vectors/tools/gen.mjs
// (make vectors runs it in node:24-alpine). Keys are created once under
// vectors/keys/ and reused, so RS256 and EdDSA tokens are byte-stable across
// runs; ES256 signatures are randomised by the algorithm and change on every
// run, which is why SHA256SUMS is rewritten only when the cases change.
//
// The expected verdicts below are written by hand from TOKENS.md. They are
// checked by an independent implementation (vectors/tools/check, Go standard
// library only), which must agree on every case.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const KEYS = path.join(ROOT, "vectors", "keys");
const OUT = path.join(ROOT, "vectors", "tokens");

// ---------- keys ----------
const KEYSPEC = {
  "plat-rs-2": { kind: "rsa", alg: "RS256", note: "platform, current RSA key" },
  "plat-rs-1": { kind: "rsa", alg: "RS256", note: "platform, previous RSA key (rotation)" },
  "plat-ec-1": { kind: "ec", alg: "ES256", note: "platform, P-256 key" },
  "plat-ed-1": { kind: "ed25519", alg: "EdDSA", note: "platform, Ed25519 key" },
  "atk-rs": { kind: "rsa", alg: "RS256", note: "attacker key, never published" },
  "idp-rs-1": { kind: "rsa", alg: "RS256", note: "the IdP's key (subject-token vectors)" },
  "idp-ec-1": { kind: "ec", alg: "ES256", note: "the IdP's second key" },
};

function loadKey(name) {
  const file = path.join(KEYS, `${name}.private.jwk.json`);
  let jwk;
  if (fs.existsSync(file)) {
    jwk = JSON.parse(fs.readFileSync(file, "utf8"));
  } else {
    const spec = KEYSPEC[name];
    const pair =
      spec.kind === "rsa" ? crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
      : spec.kind === "ec" ? crypto.generateKeyPairSync("ec", { namedCurve: "P-256" })
      : crypto.generateKeyPairSync("ed25519");
    jwk = { ...pair.privateKey.export({ format: "jwk" }), kid: name, alg: spec.alg, use: "sig",
      x_note: `TEST KEY ONLY, published on purpose: ${spec.note}` };
    fs.mkdirSync(KEYS, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(jwk, null, 2) + "\n");
  }
  const priv = crypto.createPrivateKey({ key: jwk, format: "jwk" });
  const pub = crypto.createPublicKey(priv);
  const pubJwk = { ...pub.export({ format: "jwk" }), kid: jwk.kid, alg: jwk.alg, use: "sig" };
  return { name, alg: jwk.alg, priv, pub, pubJwk };
}
const K = Object.fromEntries(Object.keys(KEYSPEC).map((n) => [n, loadKey(n)]));

// ---------- JWT ----------
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const enc = (obj) => b64u(JSON.stringify(obj));

function sign(alg, key, input) {
  const data = Buffer.from(input);
  if (alg === "RS256") return crypto.sign("sha256", data, { key, padding: crypto.constants.RSA_PKCS1_PADDING });
  if (alg === "ES256") return crypto.sign("sha256", data, { key, dsaEncoding: "ieee-p1363" });
  if (alg === "EdDSA") return crypto.sign(null, data, key);
  throw new Error("alg " + alg);
}

// jwt({key, alg, header, claims}) -> compact. alg defaults to the key's alg.
function jwt({ key, alg, header, claims, signAlg }) {
  const h = header ?? { alg: alg ?? key.alg, kid: key.name, typ: "JWT" };
  const input = enc(h) + "." + enc(claims);
  return input + "." + b64u(sign(signAlg ?? key.alg, key.priv, input));
}
function jwtNone(claims) {
  return enc({ alg: "none", typ: "JWT" }) + "." + enc(claims) + ".";
}
function jwtHS256WithPublicKey(claims, key) {
  // The classic algorithm-confusion attack: HMAC keyed with the RSA public key PEM.
  const h = { alg: "HS256", kid: key.name, typ: "JWT" };
  const input = enc(h) + "." + enc(claims);
  const secret = key.pub.export({ format: "pem", type: "spki" });
  return input + "." + b64u(crypto.createHmac("sha256", secret).update(input).digest());
}
function tamper(token) {
  // Change one claim byte after signing: same header and signature, other payload.
  const [h, p, s] = token.split(".");
  const claims = JSON.parse(Buffer.from(p, "base64url"));
  claims.roles = ["dev.superuser"];
  return h + "." + enc(claims) + "." + s;
}

// ---------- access-token vectors (be-protocol P5, TOKENS.md "Verification") ----------
const NOW = 1790000000; // 2026-09-21T13:33:20Z
const ISS = "urn:be:t-test:iam";
const TENANT = "t-test";
const SUB = "01926f3e-4c6b-7a10-9c2e-3b7d5e8f1a20";
const ADMIN = "01926f3e-4c6b-7a10-9c2e-3b7d5e8f1a21";
const JTI = "01926f3e-4c6b-7c00-8d11-0a1b2c3d4e5f";
const DG = "01926f3e-4c6b-7d00-a111-2b3c4d5e6f70";

const base = (over = {}, drop = []) => {
  const c = {
    iss: ISS, aud: [TENANT], sub: SUB, typ: "access",
    iat: NOW - 30, nbf: NOW - 30, exp: NOW - 30 + 600, jti: JTI,
    tenant_id: TENANT, roles: ["sales.rep"], dept_path: "/01926f3e-0000-7000-8000-000000000001/",
    azp: "pc", locale: "zh-CN", ...over,
  };
  for (const d of drop) delete c[d];
  return c;
};
const OK = (extra = {}) => ({ valid: true, sub: SUB, ...extra });
const BAD = (rule, reason = "TOKEN_INVALID") => ({ valid: false, status: 401, reason, domain: "be", rule });

const R = K["plat-rs-2"];
const accessCases = [
  ["AT-001", "valid RS256, current key", jwt({ key: R, claims: base() }), {}, OK()],
  ["AT-002", "valid ES256", jwt({ key: K["plat-ec-1"], claims: base() }), {}, OK()],
  ["AT-003", "valid EdDSA", jwt({ key: K["plat-ed-1"], claims: base() }), {}, OK()],
  ["AT-004", "valid, signed by the previous key during a rotation", jwt({ key: K["plat-rs-1"], claims: base() }), {}, OK()],
  ["AT-005", "aud as a plain string equal to TENANT_ID", jwt({ key: R, claims: base({ aud: TENANT }) }), {}, OK()],
  ["AT-006", "aud array with TENANT_ID among others", jwt({ key: R, claims: base({ aud: ["other-api", TENANT] }) }), {}, OK()],
  ["AT-007", "unknown claims are ignored", jwt({ key: R, claims: base({ x_extra: { a: 1 }, org_id: "legacy" }) }), {}, OK()],
  ["AT-008", "service account sub svc:<id>", jwt({ key: R, claims: base({ sub: "svc:edi", azp: "svc" }, ["dept_path", "locale"]) }), {}, { valid: true, sub: "svc:edi" }],
  ["AT-009", "minimal claims: no roles, no dept_path, no locale, no tenant_id, no nbf", jwt({ key: R, claims: base({}, ["roles", "dept_path", "locale", "tenant_id", "nbf", "azp"]) }), {}, OK()],
  ["AT-010", "typ refresh is refused", jwt({ key: R, claims: base({ typ: "refresh" }) }), {}, BAD("typ")],
  ["AT-011", "typ missing is refused", jwt({ key: R, claims: base({}, ["typ"]) }), {}, BAD("typ")],
  ["AT-012", "typ with another value is refused", jwt({ key: R, claims: base({ typ: "Bearer" }) }), {}, BAD("typ")],
  ["AT-013", "wrong iss", jwt({ key: R, claims: base({ iss: "urn:be:other:iam" }) }), {}, BAD("iss")],
  ["AT-014", "missing iss", jwt({ key: R, claims: base({}, ["iss"]) }), {}, BAD("iss")],
  ["AT-015", "aud without TENANT_ID", jwt({ key: R, claims: base({ aud: ["t-other"] }) }), {}, BAD("aud")],
  ["AT-016", "missing aud", jwt({ key: R, claims: base({}, ["aud"]) }), {}, BAD("aud")],
  ["AT-017", "aud array holding a non-string", jwt({ key: R, claims: base({ aud: [TENANT, 7] }) }), {}, BAD("aud")],
  ["AT-018", "expired beyond the 60 s skew", jwt({ key: R, claims: base({ iat: NOW - 700, nbf: NOW - 700, exp: NOW - 61 }) }), {}, BAD("exp")],
  ["AT-019", "expired but within the 60 s skew (now < exp + skew)", jwt({ key: R, claims: base({ iat: NOW - 659, nbf: NOW - 659, exp: NOW - 59 }) }), {}, OK()],
  ["AT-020", "missing exp", jwt({ key: R, claims: base({}, ["exp"]) }), {}, BAD("exp")],
  ["AT-021", "nbf in the future beyond the skew", jwt({ key: R, claims: base({ nbf: NOW + 61 }) }), {}, BAD("nbf")],
  ["AT-022", "nbf in the future within the skew", jwt({ key: R, claims: base({ nbf: NOW + 60 }) }), {}, OK()],
  ["AT-023", "iat in the future beyond the skew", jwt({ key: R, claims: base({ iat: NOW + 61, nbf: NOW - 30 }) }), {}, BAD("iat")],
  ["AT-024", "missing iat", jwt({ key: R, claims: base({}, ["iat"]) }), {}, BAD("iat")],
  ["AT-025", "missing jti", jwt({ key: R, claims: base({}, ["jti"]) }), {}, BAD("jti")],
  ["AT-026", "empty sub", jwt({ key: R, claims: base({ sub: "" }) }), {}, BAD("sub")],
  ["AT-027", "exp as a string", jwt({ key: R, claims: base({ exp: String(NOW + 570) }) }), {}, BAD("exp")],
  ["AT-028", "roles not an array of strings (P5.9)", jwt({ key: R, claims: base({ roles: "sales.rep" }) }), {}, BAD("claim_type")],
  ["AT-029", "dept_path not a string (P5.9)", jwt({ key: R, claims: base({ dept_path: ["/1/"] }) }), {}, BAD("claim_type")],
  ["AT-030", "alg none", jwtNone(base()), {}, BAD("alg")],
  ["AT-031", "HS256 keyed with the RSA public key (algorithm confusion)", jwtHS256WithPublicKey(base(), R), {}, BAD("alg")],
  ["AT-032", "header alg differs from the JWKS key's alg (RS256 header on the P-256 kid)", jwt({ key: K["plat-ec-1"], header: { alg: "RS256", kid: "plat-ec-1", typ: "JWT" }, claims: base(), signAlg: "ES256" }), {}, BAD("alg")],
  ["AT-033", "missing kid", jwt({ key: R, header: { alg: "RS256", typ: "JWT" }, claims: base() }), {}, BAD("kid")],
  ["AT-034", "unknown kid (still unknown after the one refetch)", jwt({ key: K["atk-rs"], claims: base() }), {}, BAD("kid")],
  ["AT-035", "known kid, signature by another key", jwt({ key: K["atk-rs"], header: { alg: "RS256", kid: "plat-rs-2", typ: "JWT" }, claims: base() }), {}, BAD("signature")],
  ["AT-036", "payload changed after signing", tamper(jwt({ key: R, claims: base() })), {}, BAD("signature")],
  ["AT-037", "not a compact JWS (two segments)", "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0", {}, BAD("format")],
  ["AT-038", "a Casdoor ID token, even if its key were in the JWKS (repro r1-09): aud is a client id, no typ claim",
    jwt({ key: R, claims: { iss: "http://localhost:38000", aud: ["r1-spa-client-id"], sub: "21ff3de6-c4be-4069-9715-3c7997b4c7f7",
      tokenType: "access-token", azp: "r1-spa-client-id", iat: NOW - 30, nbf: NOW - 30, exp: NOW + 3570, jti: "admin/b54c3ce9-16bb-4b0f-a309-af94e7356899", name: "alice" } }),
    { issuer: "http://localhost:38000" }, BAD("aud")],
  ["AT-039", "a platform refresh token presented as an access token (typ refresh, aud = issuer)",
    jwt({ key: R, claims: { iss: ISS, aud: [ISS], sub: SUB, typ: "refresh", iat: NOW - 30, exp: NOW + 86400, jti: JTI, sid: DG, azp: "pc" } }), {}, BAD("aud")],
  // delegation (P5.5): act, ceil, dg against the bundle capabilities
  ["AT-040", "impersonation token (act user, ceil, dg) with delegation=true",
    jwt({ key: R, claims: base({ act: { sub: ADMIN, kind: "user" }, ceil: ["impersonate.read_only"], dg: DG }) }), {}, OK({ act_sub: ADMIN })],
  ["AT-041", "ceil and dg when the authorization provider lacks delegation",
    jwt({ key: R, claims: base({ act: { sub: ADMIN, kind: "user" }, ceil: ["impersonate.read_only"], dg: DG }) }),
    { capabilities: { delegation: false, agents: false } }, BAD("delegation", "UNSUPPORTED_DELEGATION")],
  ["AT-042", "act.kind agent when agents=false (A4: reserved)",
    jwt({ key: R, claims: base({ act: { sub: "01926f3e-4c6b-7a10-9c2e-3b7d5e8f1a99", kind: "agent" }, ceil: ["agent.sales_assistant"], dg: DG }) }), {}, BAD("agents", "UNSUPPORTED_DELEGATION")],
  ["AT-043", "agent deeper in a nested act chain when agents=false",
    jwt({ key: R, claims: base({ act: { sub: ADMIN, kind: "user", act: { sub: "01926f3e-4c6b-7a10-9c2e-3b7d5e8f1a99", kind: "agent" } }, ceil: ["p"], dg: DG }) }), {}, BAD("agents", "UNSUPPORTED_DELEGATION")],
  ["AT-044", "act.kind outside the enum", jwt({ key: R, claims: base({ act: { sub: ADMIN, kind: "robot" } }) }), {}, BAD("claim_type")],
  ["AT-045", "act without sub", jwt({ key: R, claims: base({ act: { kind: "user" } }) }), {}, BAD("claim_type")],
  // stale (P5.6)
  ["AT-046", "iat more than 5 s before stale_since[sub]", jwt({ key: R, claims: base() }), { stale_since: { [SUB]: NOW - 24 } },
    { valid: false, status: 401, reason: "TOKEN_STALE", domain: "be", rule: "stale", www_authenticate: 'Bearer error="token_stale"' }],
  ["AT-047", "iat within 5 s before stale_since[sub]", jwt({ key: R, claims: base() }), { stale_since: { [SUB]: NOW - 25 } }, OK()],
  ["AT-048", "stale_since of another sub does not matter", jwt({ key: R, claims: base() }), { stale_since: { [ADMIN]: NOW } }, OK()],
  // precedence: TOKEN_INVALID before UNSUPPORTED_DELEGATION before TOKEN_STALE
  ["AT-049", "expired agent token: TOKEN_INVALID wins",
    jwt({ key: R, claims: base({ exp: NOW - 120, act: { sub: ADMIN, kind: "agent" } }) }), {}, BAD("exp")],
  ["AT-050", "stale agent token: UNSUPPORTED_DELEGATION wins over TOKEN_STALE",
    jwt({ key: R, claims: base({ act: { sub: ADMIN, kind: "agent" } }) }), { stale_since: { [SUB]: NOW } }, BAD("agents", "UNSUPPORTED_DELEGATION")],
  ["AT-051", "exactly at exp + skew is expired (RFC 7519: now must be before exp)", jwt({ key: R, claims: base({ iat: NOW - 660, nbf: NOW - 660, exp: NOW - 60 }) }), {}, BAD("exp")],
];

const platJwks = { keys: ["plat-rs-2", "plat-rs-1", "plat-ec-1", "plat-ed-1"].map((n) => K[n].pubJwk) };

const accessDoc = {
  format: "iam-vectors/1",
  contract: "iam/1.0",
  kind: "access_token_verification",
  description: "A component's verification of a platform access token (be-protocol P5; TOKENS.md 'Verification'). For each case: verify `token` with `defaults` overridden by `context`, and compare `valid` and, when false, `status`, `reason` and `domain`. `rule` names the failing check for debugging and is not compared. The JWKS holds four keys so that one file covers every algorithm; a real JWKS holds at most three. No case needs network: an unknown kid is unknown after the refetch.",
  defaults: {
    now: NOW, issuer: ISS, tenant_id: TENANT, skew_seconds: 60, stale_grace_seconds: 5,
    algorithms: ["RS256", "ES256", "EdDSA"],
    capabilities: { delegation: true, agents: false },
    stale_since: {},
    jwks: platJwks,
  },
  cases: accessCases.map(([id, name, token, context, expect]) => ({ id, name, token, context, expect })),
};

// ---------- subject-token vectors (member side, TOKENS.md "Subject token") ----------
const IDP = "https://idp.example.test";
const IDPSUB = "idp-user-7f3a";
const SPA = "spa-pc-client";
const idpBase = (over = {}, drop = []) => {
  const c = { iss: IDP, aud: [SPA], sub: IDPSUB, iat: NOW - 20, exp: NOW - 20 + 3600, nonce: "n-1",
    email: "alice@example.test", email_verified: true, name: "Alice", ...over };
  for (const d of drop) delete c[d];
  return c;
};
const I = K["idp-rs-1"];
const SOK = (extra = {}) => ({ valid: true, idp_issuer: IDP, idp_sub: IDPSUB, ...extra });
const SBAD = (rule) => ({ valid: false, status: 401, reason: "SUBJECT_TOKEN_INVALID", domain: "infra/iam", rule, oauth_error: "invalid_grant" });

const subjectCases = [
  ["ST-001", "valid generic OIDC ID token", jwt({ key: I, claims: idpBase() }), {}, SOK({ client_id: SPA })],
  ["ST-002", "valid, ES256 key of the IdP", jwt({ key: K["idp-ec-1"], claims: idpBase() }), {}, SOK({ client_id: SPA })],
  ["ST-003", "aud is a client the member does not trust", jwt({ key: I, claims: idpBase({ aud: ["other-app"] }) }), {}, SBAD("aud")],
  ["ST-004", "several audiences, no azp (OIDC Core 3.1.3.7)", jwt({ key: I, claims: idpBase({ aud: [SPA, "other-app"] }) }), {}, SBAD("azp")],
  ["ST-005", "several audiences, azp a trusted client", jwt({ key: I, claims: idpBase({ aud: [SPA, "other-app"], azp: SPA }) }), {}, SOK({ client_id: SPA })],
  ["ST-006", "azp present but not a trusted client", jwt({ key: I, claims: idpBase({ azp: "other-app" }) }), {}, SBAD("azp")],
  ["ST-007", "aud as a plain string", jwt({ key: I, claims: idpBase({ aud: SPA }) }), {}, SOK({ client_id: SPA })],
  ["ST-008", "second trusted client (mobile)", jwt({ key: I, claims: idpBase({ aud: ["spa-mobile-client"] }) }), {}, SOK({ client_id: "spa-mobile-client" })],
  ["ST-009", "iss is not the IdP", jwt({ key: I, claims: idpBase({ iss: "https://evil.example.test" }) }), {}, SBAD("iss")],
  ["ST-010", "expired beyond the skew", jwt({ key: I, claims: idpBase({ iat: NOW - 4000, exp: NOW - 61 }) }), {}, SBAD("exp")],
  ["ST-011", "older than max_age + skew even though not expired", jwt({ key: I, claims: idpBase({ iat: NOW - 661, exp: NOW + 2939 }) }), {}, SBAD("max_age")],
  ["ST-027", "exactly max_age + skew old is still accepted", jwt({ key: I, claims: idpBase({ iat: NOW - 660, exp: NOW + 2940 }) }), {}, SOK({ client_id: SPA })],
  ["ST-012", "iat in the future beyond the skew", jwt({ key: I, claims: idpBase({ iat: NOW + 61 }) }), {}, SBAD("iat")],
  ["ST-013", "nbf in the future beyond the skew", jwt({ key: I, claims: idpBase({ nbf: NOW + 61 }) }), {}, SBAD("nbf")],
  ["ST-014", "missing sub", jwt({ key: I, claims: idpBase({}, ["sub"]) }), {}, SBAD("sub")],
  ["ST-015", "missing kid", jwt({ key: I, header: { alg: "RS256", typ: "JWT" }, claims: idpBase() }), {}, SBAD("kid")],
  ["ST-016", "alg none", jwtNone(idpBase()), {}, SBAD("alg")],
  ["ST-017", "HS256 keyed with the IdP's public key", jwtHS256WithPublicKey(idpBase(), I), {}, SBAD("alg")],
  ["ST-018", "known kid, signature by another key", jwt({ key: K["atk-rs"], header: { alg: "RS256", kid: "idp-rs-1", typ: "JWT" }, claims: idpBase() }), {}, SBAD("signature")],
  ["ST-019", "Casdoor ID token (repro r1-09): no typ, tokenType access-token, same JWT as its access token",
    jwt({ key: I, claims: idpBase({ tokenType: "access-token", azp: SPA, jti: "admin/b54c3ce9-16bb-4b0f-a309-af94e7356899", owner: "r1", id: IDPSUB }) }), {}, SOK({ client_id: SPA })],
  ["ST-020", "Casdoor refresh token as Casdoor issues it (tokenType refresh-token, no kid)",
    jwt({ key: I, header: { alg: "RS256", typ: "JWT" }, claims: idpBase({ tokenType: "refresh-token", azp: SPA, exp: NOW + 86380 }) }), {}, SBAD("kid")],
  ["ST-021", "Casdoor refresh token with a kid: refused by its token type, not by luck",
    jwt({ key: I, claims: idpBase({ tokenType: "refresh-token", azp: SPA, exp: NOW + 86380 }) }), {}, SBAD("token_type")],
  ["ST-022", "Keycloak ID token (typ ID)", jwt({ key: I, claims: idpBase({ typ: "ID", azp: SPA }) }), {}, SOK({ client_id: SPA })],
  ["ST-023", "Keycloak refresh token (typ Refresh)", jwt({ key: I, claims: idpBase({ typ: "Refresh", azp: SPA }) }), {}, SBAD("token_type")],
  ["ST-024", "Keycloak access token (typ Bearer)", jwt({ key: I, claims: idpBase({ typ: "Bearer", azp: SPA }) }), {}, SBAD("token_type")],
  ["ST-025", "a platform access token presented as an ID token", jwt({ key: R, claims: base() }), {}, SBAD("kid")],
  ["ST-026", "email_verified false is still a valid ID token (it only blocks e-mail auto-linking)",
    jwt({ key: I, claims: idpBase({ email_verified: false }) }), {}, SOK({ client_id: SPA, email_verified: false })],
];

const idpJwks = { keys: ["idp-rs-1", "idp-ec-1"].map((n) => K[n].pubJwk) };
const subjectDoc = {
  format: "iam-vectors/1",
  contract: "iam/1.0",
  kind: "subject_token_verification",
  description: "An IAM member's verification of the IdP ID token presented as subject_token to POST /api/iam/token (TOKENS.md 'Subject token'). Compare `valid` and, when false, `status`, `reason`, `domain`; when true, `idp_issuer`, `idp_sub` and `client_id` (the trusted client the token was issued to). Single use of a subject token is stateful and tested by iamconf, not here.",
  defaults: {
    now: NOW, idp_issuer: IDP, trusted_client_ids: [SPA, "spa-mobile-client"], skew_seconds: 60, max_age_seconds: 600,
    algorithms: ["RS256", "ES256", "EdDSA"], jwks: idpJwks,
  },
  cases: subjectCases.map(([id, name, token, context, expect]) => ({ id, name, token, context, expect })),
};

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "access-token.json"), JSON.stringify(accessDoc, null, 2) + "\n");
fs.writeFileSync(path.join(OUT, "subject-token.json"), JSON.stringify(subjectDoc, null, 2) + "\n");

// SHA256SUMS over every vector file and every key, sorted, sha256sum format.
const files = [
  ...fs.readdirSync(OUT).map((f) => path.join("tokens", f)),
  ...fs.readdirSync(KEYS).map((f) => path.join("keys", f)),
].sort();
const sums = files.map((f) => crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, "vectors", f))).digest("hex") + "  " + f).join("\n") + "\n";
fs.writeFileSync(path.join(ROOT, "vectors", "SHA256SUMS"), sums);
console.log(`wrote ${accessDoc.cases.length} access-token cases, ${subjectDoc.cases.length} subject-token cases, ${files.length} checksums`);
