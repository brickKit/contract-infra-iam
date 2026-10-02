// Command check is the independent cross-check of the token vectors of
// contract-infra-iam: a second implementation of TOKENS.md "Verification" and
// "Subject token", written with the Go standard library only (no JWT library),
// that must reach the verdict gen.mjs wrote for every case.
//
// Run from the repository root: go run ./vectors/tools/check
// (make vectors-check runs it in golang:1.25-alpine).
package main

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

type jwk struct {
	Kty, Kid, Alg, Use, N, E, Crv, X, Y string
}

type key struct {
	alg string
	pub any
}

type verdict struct {
	valid    bool
	reason   string // TOKEN_INVALID | UNSUPPORTED_DELEGATION | TOKEN_STALE | SUBJECT_TOKEN_INVALID
	rule     string
	sub      string
	actSub   string
	clientID string
}

func b64(s string) ([]byte, error) { return base64.RawURLEncoding.DecodeString(s) }

func loadJWKS(raw json.RawMessage) (map[string]key, error) {
	var set struct{ Keys []jwk }
	if err := json.Unmarshal(raw, &set); err != nil {
		return nil, err
	}
	out := map[string]key{}
	for _, k := range set.Keys {
		switch k.Kty {
		case "RSA":
			n, err1 := b64(k.N)
			e, err2 := b64(k.E)
			if err1 != nil || err2 != nil {
				return nil, fmt.Errorf("bad RSA key %s", k.Kid)
			}
			out[k.Kid] = key{k.Alg, &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Int64())}}
		case "EC":
			x, err1 := b64(k.X)
			y, err2 := b64(k.Y)
			if err1 != nil || err2 != nil || k.Crv != "P-256" {
				return nil, fmt.Errorf("bad EC key %s", k.Kid)
			}
			pt := append(append([]byte{4}, x...), y...)
			pub, err := ecdsa.ParseUncompressedPublicKey(elliptic.P256(), pt)
			if err != nil {
				return nil, err
			}
			out[k.Kid] = key{k.Alg, pub}
		case "OKP":
			x, err := b64(k.X)
			if err != nil || k.Crv != "Ed25519" {
				return nil, fmt.Errorf("bad OKP key %s", k.Kid)
			}
			out[k.Kid] = key{k.Alg, ed25519.PublicKey(x)}
		}
	}
	return out, nil
}

func verifySig(alg string, pub any, input, sig []byte) bool {
	h := sha256.Sum256(input)
	switch alg {
	case "RS256":
		p, ok := pub.(*rsa.PublicKey)
		return ok && rsa.VerifyPKCS1v15(p, crypto.SHA256, h[:], sig) == nil
	case "ES256":
		p, ok := pub.(*ecdsa.PublicKey)
		if !ok || len(sig) != 64 {
			return false
		}
		return ecdsa.Verify(p, h[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:]))
	case "EdDSA":
		p, ok := pub.(ed25519.PublicKey)
		return ok && ed25519.Verify(p, input, sig)
	}
	return false
}

func decodeObj(seg string) (map[string]any, bool) {
	raw, err := b64(seg)
	if err != nil {
		return nil, false
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	var m map[string]any
	if d.Decode(&m) != nil || m == nil {
		return nil, false
	}
	return m, true
}

// jws checks format, alg, kid and signature; it returns the claims or a failing rule.
func jws(token string, keys map[string]key, algs []string) (map[string]any, string) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, "format"
	}
	hdr, ok1 := decodeObj(parts[0])
	claims, ok2 := decodeObj(parts[1])
	if !ok1 || !ok2 {
		return nil, "format"
	}
	alg, _ := hdr["alg"].(string)
	if !slices.Contains(algs, alg) {
		return nil, "alg"
	}
	kid, _ := hdr["kid"].(string)
	if kid == "" {
		return nil, "kid"
	}
	k, ok := keys[kid]
	if !ok {
		return nil, "kid"
	}
	if k.alg != alg {
		return nil, "alg"
	}
	sig, err := b64(parts[2])
	if err != nil || !verifySig(alg, k.pub, []byte(parts[0]+"."+parts[1]), sig) {
		return nil, "signature"
	}
	return claims, ""
}

func num(v any) (float64, bool) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	f, err := n.Float64()
	return f, err == nil
}

func strs(v any) ([]string, bool) {
	switch t := v.(type) {
	case string:
		return []string{t}, true
	case []any:
		out := make([]string, 0, len(t))
		for _, e := range t {
			s, ok := e.(string)
			if !ok {
				return nil, false
			}
			out = append(out, s)
		}
		return out, true
	}
	return nil, false
}

func strArray(v any) bool { _, ok := v.([]any); s, ok2 := strs(v); return ok && ok2 && s != nil }

// actChain validates act recursively and reports whether an agent appears.
func actChain(v any) (agent bool, firstSub string, ok bool) {
	m, isObj := v.(map[string]any)
	if !isObj {
		return false, "", false
	}
	sub, _ := m["sub"].(string)
	kind, _ := m["kind"].(string)
	if sub == "" || !slices.Contains([]string{"user", "agent", "svc"}, kind) {
		return false, "", false
	}
	agent = kind == "agent"
	if inner, has := m["act"]; has {
		a, _, ok := actChain(inner)
		if !ok {
			return false, "", false
		}
		agent = agent || a
	}
	return agent, sub, true
}

type accessCtx struct {
	Now          float64            `json:"now"`
	Issuer       string             `json:"issuer"`
	TenantID     string             `json:"tenant_id"`
	Skew         float64            `json:"skew_seconds"`
	StaleGrace   float64            `json:"stale_grace_seconds"`
	Algorithms   []string           `json:"algorithms"`
	Capabilities map[string]bool    `json:"capabilities"`
	StaleSince   map[string]float64 `json:"stale_since"`
	JWKS         json.RawMessage    `json:"jwks"`
}

func verifyAccess(token string, c accessCtx, keys map[string]key) verdict {
	bad := func(rule string) verdict { return verdict{reason: "TOKEN_INVALID", rule: rule} }
	cl, rule := jws(token, keys, c.Algorithms)
	if rule != "" {
		return bad(rule)
	}
	// P5.9: types of the optional claims a component reads
	for _, name := range []string{"roles", "ceil"} {
		if v, ok := cl[name]; ok && !strArray(v) {
			return bad("claim_type")
		}
	}
	for _, name := range []string{"dept_path", "tenant_id", "azp", "locale", "dg"} {
		if v, ok := cl[name]; ok {
			if _, isStr := v.(string); !isStr {
				return bad("claim_type")
			}
		}
	}
	agent, actSub := false, ""
	if v, ok := cl["act"]; ok {
		a, s, valid := actChain(v)
		if !valid {
			return bad("claim_type")
		}
		agent, actSub = a, s
	}
	if iss, _ := cl["iss"].(string); iss == "" || iss != c.Issuer {
		return bad("iss")
	}
	aud, ok := strs(cl["aud"])
	if !ok || !slices.Contains(aud, c.TenantID) {
		return bad("aud")
	}
	if typ, _ := cl["typ"].(string); typ != "access" {
		return bad("typ")
	}
	sub, _ := cl["sub"].(string)
	if sub == "" {
		return bad("sub")
	}
	exp, ok := num(cl["exp"])
	if !ok || c.Now >= exp+c.Skew {
		return bad("exp")
	}
	if v, has := cl["nbf"]; has {
		nbf, ok := num(v)
		if !ok || c.Now+c.Skew < nbf {
			return bad("nbf")
		}
	}
	iat, ok := num(cl["iat"])
	if !ok || iat > c.Now+c.Skew {
		return bad("iat")
	}
	if jti, _ := cl["jti"].(string); jti == "" {
		return bad("jti")
	}
	_, hasCeil := cl["ceil"]
	_, hasDg := cl["dg"]
	if agent && !c.Capabilities["agents"] {
		return verdict{reason: "UNSUPPORTED_DELEGATION", rule: "agents"}
	}
	if (hasCeil || hasDg) && !c.Capabilities["delegation"] {
		return verdict{reason: "UNSUPPORTED_DELEGATION", rule: "delegation"}
	}
	if s, ok := c.StaleSince[sub]; ok && iat < s-c.StaleGrace {
		return verdict{reason: "TOKEN_STALE", rule: "stale"}
	}
	return verdict{valid: true, sub: sub, actSub: actSub}
}

type subjectCtx struct {
	Now        float64         `json:"now"`
	IdpIssuer  string          `json:"idp_issuer"`
	Trusted    []string        `json:"trusted_client_ids"`
	Skew       float64         `json:"skew_seconds"`
	MaxAge     float64         `json:"max_age_seconds"`
	Algorithms []string        `json:"algorithms"`
	JWKS       json.RawMessage `json:"jwks"`
}

func verifySubject(token string, c subjectCtx, keys map[string]key) verdict {
	bad := func(rule string) verdict { return verdict{reason: "SUBJECT_TOKEN_INVALID", rule: rule} }
	cl, rule := jws(token, keys, c.Algorithms)
	if rule != "" {
		return bad(rule)
	}
	if iss, _ := cl["iss"].(string); iss != c.IdpIssuer {
		return bad("iss")
	}
	aud, ok := strs(cl["aud"])
	if !ok {
		return bad("aud")
	}
	client := ""
	for _, a := range aud {
		if slices.Contains(c.Trusted, a) {
			client = a
			break
		}
	}
	if client == "" {
		return bad("aud")
	}
	azp, hasAzp := cl["azp"].(string)
	if len(aud) > 1 && !hasAzp {
		return bad("azp")
	}
	if hasAzp {
		if !slices.Contains(c.Trusted, azp) {
			return bad("azp")
		}
		client = azp
	}
	sub, _ := cl["sub"].(string)
	if sub == "" {
		return bad("sub")
	}
	exp, ok := num(cl["exp"])
	if !ok || c.Now >= exp+c.Skew {
		return bad("exp")
	}
	iat, ok := num(cl["iat"])
	if !ok || iat > c.Now+c.Skew {
		return bad("iat")
	}
	if c.Now-iat > c.MaxAge+c.Skew {
		return bad("max_age")
	}
	if v, has := cl["nbf"]; has {
		nbf, ok := num(v)
		if !ok || c.Now+c.Skew < nbf {
			return bad("nbf")
		}
	}
	if v, has := cl["typ"]; has {
		if s, _ := v.(string); strings.ToLower(s) != "id" {
			return bad("token_type")
		}
	}
	if v, has := cl["tokenType"]; has {
		if s, _ := v.(string); s != "access-token" && s != "id-token" {
			return bad("token_type")
		}
	}
	return verdict{valid: true, sub: sub, clientID: client}
}

type vcase struct {
	ID      string          `json:"id"`
	Name    string          `json:"name"`
	Token   string          `json:"token"`
	Context json.RawMessage `json:"context"`
	Expect  map[string]any  `json:"expect"`
}

type doc struct {
	Kind     string          `json:"kind"`
	Defaults json.RawMessage `json:"defaults"`
	Cases    []vcase         `json:"cases"`
}

// merged applies a case's context over the defaults (shallow, like the README says).
func merged(defaults, override json.RawMessage) []byte {
	var d, o map[string]json.RawMessage
	_ = json.Unmarshal(defaults, &d)
	_ = json.Unmarshal(override, &o)
	for k, v := range o {
		d[k] = v
	}
	b, _ := json.Marshal(d)
	return b
}

func compare(v verdict, e map[string]any) []string {
	var diffs []string
	want := func(k string) string { s, _ := e[k].(string); return s }
	if ev, _ := e["valid"].(bool); ev != v.valid {
		return []string{fmt.Sprintf("valid: want %v, got %v (reason %s, rule %s)", ev, v.valid, v.reason, v.rule)}
	}
	if !v.valid {
		if want("reason") != v.reason {
			diffs = append(diffs, fmt.Sprintf("reason: want %s, got %s (rule %s)", want("reason"), v.reason, v.rule))
		}
		if w := want("rule"); w != "" && w != v.rule {
			// rules are informative; a mismatch is reported but not fatal
			fmt.Printf("    note: rule want %s, got %s\n", w, v.rule)
		}
		return diffs
	}
	if w := want("sub"); w != "" && w != v.sub {
		diffs = append(diffs, fmt.Sprintf("sub: want %s, got %s", w, v.sub))
	}
	if w := want("idp_sub"); w != "" && w != v.sub {
		diffs = append(diffs, fmt.Sprintf("idp_sub: want %s, got %s", w, v.sub))
	}
	if w := want("act_sub"); w != "" && w != v.actSub {
		diffs = append(diffs, fmt.Sprintf("act_sub: want %s, got %s", w, v.actSub))
	}
	if w := want("client_id"); w != "" && w != v.clientID {
		diffs = append(diffs, fmt.Sprintf("client_id: want %s, got %s", w, v.clientID))
	}
	return diffs
}

func checkSums(root string) error {
	raw, err := os.ReadFile(filepath.Join(root, "SHA256SUMS"))
	if err != nil {
		return err
	}
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		sum, name, ok := strings.Cut(line, "  ")
		if !ok {
			return fmt.Errorf("bad SHA256SUMS line %q", line)
		}
		b, err := os.ReadFile(filepath.Join(root, name))
		if err != nil {
			return err
		}
		h := sha256.Sum256(b)
		if hex.EncodeToString(h[:]) != sum {
			return fmt.Errorf("checksum mismatch: %s", name)
		}
	}
	return nil
}

func main() {
	root := "vectors"
	failed := 0
	if err := checkSums(root); err != nil {
		fmt.Println("SHA256SUMS:", err)
		failed++
	} else {
		fmt.Println("SHA256SUMS ok")
	}
	for _, f := range []string{"tokens/access-token.json", "tokens/subject-token.json"} {
		raw, err := os.ReadFile(filepath.Join(root, f))
		if err != nil {
			fmt.Println(err)
			os.Exit(2)
		}
		var d doc
		if err := json.Unmarshal(raw, &d); err != nil {
			fmt.Println(f, err)
			os.Exit(2)
		}
		pass := 0
		for _, c := range d.Cases {
			ctx := merged(d.Defaults, c.Context)
			var v verdict
			switch d.Kind {
			case "access_token_verification":
				var ac accessCtx
				_ = json.Unmarshal(ctx, &ac)
				keys, err := loadJWKS(ac.JWKS)
				if err != nil {
					fmt.Println(err)
					os.Exit(2)
				}
				v = verifyAccess(c.Token, ac, keys)
			case "subject_token_verification":
				var sc subjectCtx
				_ = json.Unmarshal(ctx, &sc)
				keys, err := loadJWKS(sc.JWKS)
				if err != nil {
					fmt.Println(err)
					os.Exit(2)
				}
				v = verifySubject(c.Token, sc, keys)
			default:
				fmt.Println("unknown kind", d.Kind)
				os.Exit(2)
			}
			if diffs := compare(v, c.Expect); len(diffs) > 0 {
				failed++
				fmt.Printf("FAIL %s %s: %s\n", c.ID, c.Name, strings.Join(diffs, "; "))
			} else {
				pass++
			}
		}
		fmt.Printf("%s: %d/%d cases agree\n", f, pass, len(d.Cases))
	}
	if failed > 0 {
		os.Exit(1)
	}
}
