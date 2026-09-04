# CodeCraft Studio - build, test and run.
#
#   make setup     install every dependency
#   make dev       run the gateway and the frontend together
#   make test      run every test suite
#   make doctor    report what this host can actually do

SHELL := /bin/bash
.DEFAULT_GOAL := help

BACKEND      := backend
FRONTEND     := frontend
SUPERVISOR   := core/supervisor
ANALYZER     := core/analyzer
VENV         := $(BACKEND)/.venv
PY           := $(VENV)/bin/python
PIP          := $(VENV)/bin/pip

GATEWAY_HOST ?= 127.0.0.1
GATEWAY_PORT ?= 8000

.PHONY: help
help:
	@printf '\nCodeCraft Studio\n\n'
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'
	@printf '\n'

# ---------------------------------------------------------------- setup
.PHONY: setup
setup: setup-backend setup-frontend analyzer supervisor ## Install dependencies and build the core services
	@printf '\n\033[1;32mSetup complete.\033[0m Run "make doctor" to see this host'"'"'s capabilities.\n\n'

.PHONY: setup-backend
setup-backend: $(VENV) ## Create the Python virtualenv and install gateway dependencies
	@$(PIP) install -q -r $(BACKEND)/requirements-dev.txt
	@printf 'Backend dependencies installed.\n'

$(VENV):
	@python3 -m venv $(VENV)
	@$(PIP) install -q --upgrade pip

.PHONY: setup-frontend
setup-frontend: ## Install frontend dependencies
	@cd $(FRONTEND) && npm install --no-audit --no-fund

# ---------------------------------------------------------------- build
.PHONY: analyzer
analyzer: ## Build the C++ static analyzer
	@$(MAKE) -s -C $(ANALYZER) all
	@printf 'Analyzer built: $(ANALYZER)/build/codecraft-analyzer\n'

.PHONY: supervisor
supervisor: ## Build the Rust supervisor daemon
	@cd $(SUPERVISOR) && cargo build --release --quiet
	@printf 'Supervisor built: $(SUPERVISOR)/target/release/codecraft-supervisor\n'

.PHONY: build
build: analyzer supervisor ## Build the core services and the production frontend bundle
	@cd $(FRONTEND) && npm run build

# ---------------------------------------------------------------- run
.PHONY: backend
backend: ## Run the gateway on port 8000
	@cd $(BACKEND) && .venv/bin/python -m uvicorn app.main:app \
		--host $(GATEWAY_HOST) --port $(GATEWAY_PORT) --reload

.PHONY: frontend
frontend: ## Run the Vite dev server on port 5173
	@cd $(FRONTEND) && npm run dev

.PHONY: daemon
daemon: supervisor ## Run the supervisor daemon on a local socket
	@mkdir -p run
	@CODECRAFT_RUNNER=$(PWD)/scripts/sandbox_runner.sh \
		$(SUPERVISOR)/target/release/codecraft-supervisor \
		--socket $(PWD)/run/supervisor.sock \
		--runner $(PWD)/scripts/sandbox_runner.sh

.PHONY: dev
dev: ## Run the gateway and the frontend together
	@trap 'kill 0' EXIT INT TERM; \
	( cd $(BACKEND) && .venv/bin/python -m uvicorn app.main:app \
		--host $(GATEWAY_HOST) --port $(GATEWAY_PORT) --reload ) & \
	( cd $(FRONTEND) && npm run dev ) & \
	wait

# ---------------------------------------------------------------- test
.PHONY: test
test: test-sandbox test-supervisor test-analyzer test-backend test-frontend ## Run every test suite
	@printf '\n\033[1;32mAll suites passed.\033[0m\n\n'

.PHONY: test-sandbox
test-sandbox: ## Run the sandbox conformance suite
	@./scripts/selftest.sh

.PHONY: test-supervisor
test-supervisor: ## Run the Rust unit tests
	@cd $(SUPERVISOR) && cargo test --quiet

.PHONY: test-analyzer
test-analyzer: ## Run the C++ analyzer tests
	@$(MAKE) -s -C $(ANALYZER) test

.PHONY: test-backend
test-backend: ## Run the gateway test suite
	@cd $(BACKEND) && .venv/bin/python -m pytest -q

.PHONY: test-frontend
test-frontend: ## Run the frontend unit tests and typecheck
	@cd $(FRONTEND) && npm run typecheck && npx vitest run

# ---------------------------------------------------------------- ops
.PHONY: doctor
doctor: ## Report this host's isolation tier and installed runtimes
	@./scripts/doctor.sh --verbose

.PHONY: provision
provision: ## Install language toolchains (needs root)
	@./scripts/provision_toolchains.sh --group core

.PHONY: clean
clean: ## Remove build artefacts
	@rm -rf $(FRONTEND)/dist $(FRONTEND)/node_modules/.vite
	@rm -rf $(ANALYZER)/build
	@cd $(SUPERVISOR) && cargo clean --quiet 2>/dev/null || true
	@find . -name __pycache__ -type d -prune -exec rm -rf {} + 2>/dev/null || true
	@rm -rf /var/tmp/codecraft/run_* /var/tmp/codecraft/.stage 2>/dev/null || true
	@printf 'Cleaned.\n'
