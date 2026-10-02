#!/usr/bin/env python3
"""Static checks of contract-infra-iam (make validate; runs in python:3.13-slim).

1. Every JSON Schema under schemas/ is a valid Draft 2020-12 schema; cross-file
   $refs resolve.
2. Every example under examples/ validates (valid-*) or fails
   (invalid-*) against its schema; examples/export.ndjson validates line by line
   and its footer counts and sha256 match.
3. events/iam.events.json: subjects follow foundations 13, each event has
   x-aggregate-type, x-consumption (be-protocol key names), grade; payload schemas are valid; capability
   names exist.
4. capabilities.yaml and errors.yaml: structure, unique names, gRPC code to
   HTTP status as in be-protocol P4.
5. openapi/*.yaml and openapi/extensions/*.yaml validate as OpenAPI 3.1
   (external $refs to ../schemas resolved).
6. The valid access-token vectors decode to claims that match
   access-token.schema.json.
Exit 1 on the first group with a failure; every failure in the group is printed.
"""
import base64
import hashlib
import json
import pathlib
import re
import sys

import yaml
from jsonschema import Draft202012Validator, FormatChecker
from openapi_spec_validator import validate as validate_openapi
from openapi_spec_validator.readers import read_from_filename
from referencing import Registry, Resource

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCHEMAS = ROOT / "schemas"
failures = []


def fail(msg):
    failures.append(msg)
    print("FAIL", msg)


def load_schemas():
    reg = Registry()
    docs = {}
    for p in sorted(SCHEMAS.glob("*.schema.json")):
        doc = json.loads(p.read_text())
        docs[p.name] = doc
        res = Resource.from_contents(doc)
        reg = reg.with_resource(doc["$id"], res).with_resource(p.name, res)
    return docs, reg


def validator(doc, reg):
    return Draft202012Validator(doc, registry=reg, format_checker=FormatChecker())


def check_schemas(docs, reg):
    for name, doc in docs.items():
        try:
            Draft202012Validator.check_schema(doc)
            validator(doc, reg).is_valid({})  # forces $ref resolution of the root
        except Exception as e:  # noqa: BLE001
            fail(f"schema {name}: {e}")
    print(f"schemas: {len(docs)} checked")


def check_examples(docs, reg):
    n = 0
    for p in sorted((ROOT / "examples").glob("*.json")):
        schema_name, kind = p.name.split(".", 1)
        schema = docs.get(f"{schema_name}.schema.json")
        if schema is None:
            fail(f"example {p.name}: no schema {schema_name}.schema.json")
            continue
        errors = list(validator(schema, reg).iter_errors(json.loads(p.read_text())))
        if kind.startswith("valid") and errors:
            fail(f"example {p.name} should be valid: {errors[0].message}")
        if kind.startswith("invalid") and not errors:
            fail(f"example {p.name} should be invalid but validates")
        n += 1
    # NDJSON export
    exp = ROOT / "examples" / "export.ndjson"
    lines = exp.read_bytes().split(b"\n")
    if lines[-1] != b"":
        fail("export.ndjson must end with LF")
    lines = lines[:-1]
    v = validator(docs["export-record.schema.json"], reg)
    recs = []
    for i, line in enumerate(lines, 1):
        rec = json.loads(line)
        for e in v.iter_errors(rec):
            fail(f"export.ndjson line {i}: {e.message}")
        recs.append(rec)
    if recs[0]["kind"] != "header" or recs[-1]["kind"] != "footer":
        fail("export.ndjson: first line header, last line footer")
    body = b"".join(l + b"\n" for l in lines[1:-1])
    if hashlib.sha256(body).hexdigest() != recs[-1]["sha256"]:
        fail("export.ndjson: footer sha256 does not match")
    counts = {}
    for r in recs[1:-1]:
        counts[r["kind"]] = counts.get(r["kind"], 0) + 1
    for k in recs[0]["kinds"]:
        counts.setdefault(k, 0)
    if counts != recs[-1]["counts"]:
        fail(f"export.ndjson: footer counts {recs[-1]['counts']} != {counts}")
    order = ["user", "identity_link", "department_link", "department", "membership"]
    kinds = [r["kind"] for r in recs[1:-1]]
    if kinds != sorted(kinds, key=order.index):
        fail("export.ndjson: records not grouped in kind order")
    print(f"examples: {n} JSON + export.ndjson ({len(recs)} lines) checked")


def check_events(caps):
    d = json.loads((ROOT / "events" / "iam.events.json").read_text())
    subj = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+\.v[0-9]+$")
    seen = set()
    for e in d["events"]:
        s = e["subject"]
        if not subj.match(s) or not s.startswith("infra.iam."):
            fail(f"event subject {s}")
        if s in seen:
            fail(f"duplicate subject {s}")
        seen.add(s)
        for k in ("x-aggregate-type", "x-consumption", "grade", "note", "payload"):
            if k not in e:
                fail(f"event {s}: missing {k}")
        if e.get("x-consumption") not in ("state", "sequence"):
            fail(f"event {s}: x-consumption")
        if e.get("grade") not in ("core", "peripheral"):
            fail(f"event {s}: grade")
        if "capability" in e and e["capability"] not in caps:
            fail(f"event {s}: unknown capability {e['capability']}")
        schema = {"$schema": "https://json-schema.org/draft/2020-12/schema", "$defs": d["$defs"], **e["payload"]}
        try:
            Draft202012Validator.check_schema(schema)
            Draft202012Validator(schema).is_valid({})
        except Exception as ex:  # noqa: BLE001
            fail(f"event {s}: payload schema {ex}")
    print(f"events: {len(d['events'])} checked")


def check_capabilities():
    d = yaml.safe_load((ROOT / "capabilities.yaml").read_text())
    names = [c["name"] for c in d["capabilities"]]
    if len(names) != len(set(names)):
        fail("capabilities: duplicate name")
    if names[0] != "core":
        fail("capabilities: core first")
    for c in d["capabilities"]:
        for k in ("name", "group", "since", "summary", "provider", "absent", "conformance"):
            if k not in c:
                fail(f"capability {c.get('name')}: missing {k}")
        if c.get("group") not in ("core", "optional"):
            fail(f"capability {c['name']}: group")
        if not re.match(r"^[a-z][a-z0-9_]*$", c["name"]):
            fail(f"capability {c['name']}: name")
    print(f"capabilities: {len(names)} checked")
    return set(names)


HTTP = {"INVALID_ARGUMENT": 400, "FAILED_PRECONDITION": 400, "OUT_OF_RANGE": 400, "UNAUTHENTICATED": 401,
        "PERMISSION_DENIED": 403, "NOT_FOUND": 404, "ALREADY_EXISTS": 409, "ABORTED": 409,
        "RESOURCE_EXHAUSTED": 429, "UNIMPLEMENTED": 501, "UNAVAILABLE": 503, "DEADLINE_EXCEEDED": 504, "INTERNAL": 500}


def check_errors():
    d = yaml.safe_load((ROOT / "errors.yaml").read_text())
    if d["domain"] != "infra/iam":
        fail("errors: domain")
    seen = set()
    for r in d["reasons"]:
        name = r["reason"]
        if not re.match(r"^[A-Z][A-Z0-9_]*$", name) or name in seen:
            fail(f"errors: reason {name}")
        seen.add(name)
        if HTTP.get(r["code"]) != r["http"]:
            fail(f"errors: {name} code {r['code']} maps to {HTTP.get(r['code'])}, not {r['http']}")
        for k in ("title", "message"):
            if set(r[k]) != {"en", "zh"}:
                fail(f"errors: {name} {k} languages")
        for prm in r.get("params", []):
            if "{" + prm + "}" not in r["message"]["en"] or "{" + prm + "}" not in r["message"]["zh"]:
                fail(f"errors: {name} message lacks {{{prm}}}")
    print(f"errors: {len(seen)} reasons checked")


def check_openapi():
    files = sorted((ROOT / "openapi").glob("*.yaml")) + sorted((ROOT / "openapi" / "extensions").glob("*.yaml"))
    for p in files:
        try:
            spec, base_uri = read_from_filename(str(p))
            validate_openapi(spec, base_uri=base_uri)
        except Exception as e:  # noqa: BLE001
            fail(f"openapi {p.name}: {str(e).splitlines()[0]}")
    print(f"openapi: {len(files)} documents checked")


def b64json(seg):
    return json.loads(base64.urlsafe_b64decode(seg + "=" * (-len(seg) % 4)))


def check_vectors(docs, reg):
    d = json.loads((ROOT / "vectors" / "tokens" / "access-token.json").read_text())
    v = validator(docs["access-token.schema.json"], reg)
    n = 0
    for c in d["cases"]:
        if c["id"] in ("AT-001", "AT-002", "AT-003", "AT-004", "AT-040"):
            h, p, _ = c["token"].split(".")
            for e in v.iter_errors({"header": b64json(h), "claims": b64json(p)}):
                fail(f"vector {c['id']} does not match the issuer schema: {e.message}")
            n += 1
    print(f"vectors: {n} issuer-shaped tokens checked against access-token.schema.json")


def main():
    docs, reg = load_schemas()
    caps = None
    for step in (lambda: check_schemas(docs, reg), lambda: check_examples(docs, reg), None,
                 check_errors, check_openapi, lambda: check_vectors(docs, reg)):
        if step is None:
            caps = check_capabilities()
            check_events(caps)
        else:
            step()
    if failures:
        print(f"{len(failures)} failure(s)")
        sys.exit(1)
    print("all checks passed")


if __name__ == "__main__":
    main()
