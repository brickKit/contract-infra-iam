# Every target runs in a pinned container; nothing is installed on the host.
# make check is the release gate: lint, generated code up to date, Go build,
# vectors cross-checked, schemas / examples / events / OpenAPI valid.

BUF    := bufbuild/buf:1.57.0
GO     := golang:1.25-alpine
NODE   := node:24-alpine
PYTHON := python:3.13-slim
RUN    := docker run --rm -u $$(id -u):$$(id -g) -e HOME=/tmp -v $(CURDIR):/w -w /w
GOENV  := -e GOCACHE=/tmp/gocache -e GOPATH=/tmp/gopath
PYDEPS := jsonschema==4.25.1 openapi-spec-validator==0.7.2 pyyaml==6.0.3 rfc3987==1.3.8

.PHONY: check lint gen gen-check build vectors vectors-check validate breaking

check: lint gen-check build vectors-check validate

lint:
	$(RUN) $(BUF) lint

gen:
	$(RUN) $(BUF) generate

# The committed gen/go must be exactly what buf generates from proto/.
gen-check:
	@T=$$(mktemp -d) && cp -r gen $$T/ && $(RUN) $(BUF) generate && \
	  diff -r $$T/gen gen && rm -rf $$T && echo "gen/go up to date"

build:
	$(RUN) $(GOENV) $(GO) sh -c 'go vet ./... && go build ./... && test -z "$$(gofmt -l .)"'

vectors:
	$(RUN) $(NODE) node vectors/tools/gen.mjs

vectors-check:
	$(RUN) $(GOENV) $(GO) go run ./vectors/tools/check

validate:
	$(RUN) -e PIP_CACHE_DIR=/tmp/pip $(PYTHON) sh -c 'pip install -q --target /tmp/py $(PYDEPS) >/dev/null 2>&1 && PYTHONPATH=/tmp/py python tools/validate.py'

# Additive-only gate against the previous tag (FILE rules), once v1.0.0 exists.
breaking:
	$(RUN) $(BUF) breaking --against 'https://github.com/brickKit/contract-infra-iam.git#tag=$(AGAINST)'
