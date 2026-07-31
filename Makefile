# ChainStake — developer entrypoints.
# `make demo` is the canonical one-command experience.

COMPOSE := docker compose -f infra/docker-compose.yml

.DEFAULT_GOAL := help

.PHONY: help install chain contracts-build contracts-test up down demo logs ps clean lint typecheck test fmt

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

install: ## Install workspace dependencies
	pnpm install

chain: ## Run local Anvil + deploy contracts + write addresses (TODO: Phase 0)
	@echo "TODO(Phase 0): anvil + forge script Deploy.s.sol -> packages/shared/src/addresses.local.json"

contracts-build: ## Compile Solidity contracts
	pnpm --filter @chainstake/contracts build

contracts-test: ## Run Foundry tests
	pnpm --filter @chainstake/contracts test

up: ## Start the core stack (detached)
	$(COMPOSE) up -d

down: ## Stop the stack
	$(COMPOSE) down

demo: ## One-command demo: full stack incl. loadgen
	$(COMPOSE) --profile demo up

logs: ## Tail all service logs
	$(COMPOSE) logs -f

ps: ## Show running services
	$(COMPOSE) ps

clean: ## Stop and remove volumes
	$(COMPOSE) down -v

lint: ## Lint the monorepo
	pnpm lint

typecheck: ## Typecheck all packages
	pnpm typecheck

test: ## Run all tests
	pnpm test

fmt: ## Format all files
	pnpm format
