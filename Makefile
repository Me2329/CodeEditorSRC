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
ASSISTANT    := core/assistant
ANALYZER     := core/analyzer
MODEL        := core/model
VENV         := $(BACKEND)/.venv
PY           := $(VENV)/bin/python
PIP          := $(VENV)/bin/pip

GATEWAY_HOST ?= 127.0.0.1
GATEWAY_PORT ?= 8000

# The model run directory: tokenizer, token stream, checkpoint and training log.
MODEL_RUN    ?= core/model/runs/demo
MODEL_SIZE   ?= micro
# Directories normally skipped that a large corpus deliberately wants.
MODEL_ALLOW  ?= site-packages node_modules
MODEL_VOCAB  ?= 4096
MODEL_TOKENS ?= 1000000000
MODEL_STEPS  ?= 4000
MODEL_PORT   ?= 8940
# auto takes the GPU when there is one. Override with MODEL_DEVICE=cpu.
MODEL_DEVICE ?= auto
PROMPT       ?= def 

.PHONY: help
help:
	@printf '\nCodeCraft Studio\n\n'
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'
	@printf '\n'

# ---------------------------------------------------------------- setup
.PHONY: setup
setup: setup-backend setup-frontend analyzer supervisor assistant ## Install dependencies and build the core services
	@printf '\n\033[1;32mSetup complete.\033[0m Run "make doctor" to see this host'"'"'s capabilities.\n\n'

.PHONY: setup-backend
setup-backend: $(VENV) ## Create the Python virtualenv and install gateway dependencies
	@$(PIP) install -q -r $(BACKEND)/requirements-dev.txt
	@printf 'Backend dependencies installed.\n'

$(VENV):
	@python3 -m venv $(VENV)
	@$(PIP) install -q --upgrade pip

.PHONY: setup-model
setup-model: $(VENV) ## Install the model's training dependencies (torch, numpy)
	@$(PIP) install -q -r $(MODEL)/requirements.txt
	@printf 'Model dependencies installed.\n'

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

.PHONY: assistant
assistant: ## Build the Rust assistant daemon
	@cd $(ASSISTANT) && cargo build --release --quiet
	@printf 'Assistant built: $(ASSISTANT)/target/release/codecraft-assistant\n'

.PHONY: build
build: analyzer supervisor assistant ## Build the core services and the production frontend bundle
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

.PHONY: assistant-daemon
assistant-daemon: assistant ## Run the assistant daemon on a local socket
	@mkdir -p run
	@$(ASSISTANT)/target/release/codecraft-assistant --socket $(PWD)/run/assistant.sock

.PHONY: dev
dev: ## Run the gateway, the assistant and the frontend together
	@mkdir -p run
	@trap 'kill 0' EXIT INT TERM; \
	( $(ASSISTANT)/target/release/codecraft-assistant \
		--socket $(PWD)/run/assistant.sock 2>&1 | sed 's/^/[assistant] /' ) & \
	( cd $(BACKEND) && CODECRAFT_ASSISTANT_SOCKET=$(PWD)/run/assistant.sock \
		.venv/bin/python -m uvicorn app.main:app \
		--host $(GATEWAY_HOST) --port $(GATEWAY_PORT) --reload ) & \
	( cd $(FRONTEND) && npm run dev ) & \
	wait

# ---------------------------------------------------------------- test
.PHONY: test
test: test-sandbox test-supervisor test-assistant test-analyzer test-backend test-model test-frontend ## Run every test suite
	@printf '\n\033[1;32mAll suites passed.\033[0m\n\n'

.PHONY: test-sandbox
test-sandbox: ## Run the sandbox conformance suite
	@./scripts/selftest.sh

.PHONY: test-supervisor
test-supervisor: ## Run the Rust supervisor tests
	@cd $(SUPERVISOR) && cargo test --quiet

.PHONY: test-assistant
test-assistant: ## Run the Rust assistant tests
	@cd $(ASSISTANT) && cargo test --quiet

.PHONY: test-analyzer
test-analyzer: ## Run the C++ analyzer tests
	@$(MAKE) -s -C $(ANALYZER) test

.PHONY: test-backend
test-backend: ## Run the gateway test suite
	@cd $(BACKEND) && .venv/bin/python -m pytest -q

.PHONY: test-model
test-model: ## Run the language model test suite
	@cd $(MODEL) && ../../$(PY) -m pytest

.PHONY: test-frontend
test-frontend: ## Run the frontend unit tests and typecheck
	@cd $(FRONTEND) && npm run typecheck && npx vitest run

# ---------------------------------------------------------------- model
.PHONY: model-sizes
model-sizes: ## List the model sizes and their true parameter counts
	@cd $(MODEL) && ../../$(PY) -m codecraft_model sizes --device $(MODEL_DEVICE)

.PHONY: model-prepare
model-prepare: ## Build a corpus and train a tokenizer from this repository
	@cd $(MODEL) && ../../$(PY) -m codecraft_model prepare \
		--run ../../$(MODEL_RUN) --roots ../../backend ../../frontend/src ../../core ../../scripts \
		--vocab $(MODEL_VOCAB) --allow-dir $(MODEL_ALLOW)

.PHONY: model-corpus
model-corpus: ## What a corpus of a given size costs on disk
	@cd $(MODEL) && ../../$(PY) -m codecraft_model corpus

.PHONY: model-prepare-big
model-prepare-big: ## Build a billion-token corpus by cloning, reading and discarding
	@cd $(MODEL) && ../../$(PY) -m codecraft_model prepare \
		--run ../../$(MODEL_RUN) --vocab 32768 --sample-mb 40 \
		--repos-file corpora/big-code.txt --max-tokens $(MODEL_TOKENS)

.PHONY: model-train
model-train: ## Train a checkpoint (MODEL_SIZE, MODEL_STEPS)
	@cd $(MODEL) && ../../$(PY) -m codecraft_model train \
		--run ../../$(MODEL_RUN) --size $(MODEL_SIZE) --steps $(MODEL_STEPS) \
		--lr 8e-4 --warmup 200 --device $(MODEL_DEVICE)

.PHONY: model-sample
model-sample: ## Generate from the trained checkpoint
	@cd $(MODEL) && ../../$(PY) -m codecraft_model sample \
		--run ../../$(MODEL_RUN) --prompt "$(PROMPT)" --device $(MODEL_DEVICE)

.PHONY: model-verify
model-verify: assistant ## Prove the assistant daemon answers from our own weights
	@cd $(MODEL) && ../../$(PY) verify_assistant.py --run ../../$(MODEL_RUN)

.PHONY: model-serve
model-serve: ## Serve the trained model on MODEL_PORT
	@cd $(MODEL) && ../../$(PY) -m codecraft_model serve \
		--run ../../$(MODEL_RUN) --port $(MODEL_PORT) --device $(MODEL_DEVICE)

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
	@cd $(ASSISTANT) && cargo clean --quiet 2>/dev/null || true
	@find . -name __pycache__ -type d -prune -exec rm -rf {} + 2>/dev/null || true
	@rm -rf /var/tmp/codecraft/run_* /var/tmp/codecraft/.stage 2>/dev/null || true
	@printf 'Cleaned.\n'
