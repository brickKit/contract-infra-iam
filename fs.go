// Package iamcontract exposes the files of the IAM family contract (iam/1.x)
// to Go tests and tools: schemas, examples, the token vectors and their test
// keys, the capability enum, the error reasons, the events, the OpenAPI and
// the proto sources. It contains no logic. The generated gRPC package lives
// beside it in gen/go/infra/iam/v1 (package iamv1).
package iamcontract

import "embed"

// Contract is the identifier members advertise: login-config, tenant
// features and the server metadata carry "iam/1.<minor>".
const Contract = "iam/1.0"

// FS holds the contract files at their repository paths, for example
// "vectors/tokens/access-token.json" or "schemas/access-token.schema.json".
//
//go:embed capabilities.yaml errors.yaml schemas examples openapi events proto vectors/README.md vectors/SHA256SUMS vectors/tokens vectors/keys
var FS embed.FS
