# Ledgerline — developer entrypoints.
# `make demo` is the canonical one-command experience.

COMPOSE := docker compose -f infra/docker-compose.yml

.DEFAULT_GOAL := help

.PHONY: help install chain contracts-build contracts-test up down demo logs ps clean reset \
        migrate migrate-revert lint typecheck test test-integration fmt fault-clear

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

install: ## Install workspace + Foundry dependencies
	pnpm install
	cd packages/contracts && forge install --no-git foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts

chain: ## Local Anvil + deploy contracts + write addresses (TODO(Block 2.7))
	@echo "TODO(Block 2.7): anvil + forge script Deploy.s.sol -> shared volume addresses.local.json"

contracts-build: ## Compile Solidity contracts
	pnpm --filter @ledgerline/contracts build

contracts-test: ## Run Foundry tests (incl. invariants)
	pnpm --filter @ledgerline/contracts test

up: ## Start the core stack (detached)
	$(COMPOSE) up -d

down: ## Stop the stack
	$(COMPOSE) down

demo: ## One-command demo: full stack incl. loadgen + mock-psp
	$(COMPOSE) --profile demo up

logs: ## Tail all service logs
	$(COMPOSE) logs -f

ps: ## Show running services
	$(COMPOSE) ps

clean: ## Stop and remove volumes
	$(COMPOSE) down -v

# Anvil is ephemeral; Postgres is not. Restarting only Anvil leaves the database holding state for
# a chain that no longer exists, which the chain_fingerprint check refuses to start against
# (failure mode B6). This target is the fix that check points you at.
reset: ## Wipe BOTH the chain and the database, then bring the stack back up
	$(COMPOSE) down -v
	$(COMPOSE) up -d

migrate: ## Run pending database migrations
	pnpm --filter @ledgerline/indexer migration:run

migrate-revert: ## Revert the last migration
	pnpm --filter @ledgerline/indexer migration:revert

lint: ## Lint the monorepo
	pnpm lint

typecheck: ## Typecheck all packages
	pnpm typecheck

test: ## Run unit + property tests
	pnpm test

test-integration: ## Run integration tests (needs Postgres; a throwaway database per run)
	pnpm --filter @ledgerline/indexer test:integration

fmt: ## Format all files
	pnpm format

fault-clear: ## Clear every armed mock-psp fault
	curl -fsS -XDELETE http://localhost:4001/_fault && echo "faults cleared"
