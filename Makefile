.PHONY: install hooks dev dev-up dev-down dev-logs dev-ps prod prod-down build test lint format ci clean help

.DEFAULT_GOAL := help

help: ## Show this help message
	@echo 'Usage: make [target]'
	@echo ''
	@echo 'Available targets:'
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  %-15s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# ── Development (Docker) ────────────────────────────────────────────

dev: ## Start dev environment (installs deps, migrates DB, starts server)
	docker compose -f docker-compose.dev.yml up --build

dev-up: ## Start dev environment in background
	docker compose -f docker-compose.dev.yml up --build -d

dev-down: ## Stop dev environment
	docker compose -f docker-compose.dev.yml down

dev-logs: ## Tail dev logs
	docker compose -f docker-compose.dev.yml logs -f

dev-ps: ## Show running dev containers
	docker compose -f docker-compose.dev.yml ps

dev-clean: ## Stop dev environment and remove volumes
	docker compose -f docker-compose.dev.yml down -v

# ── Production (Docker) ─────────────────────────────────────────────

prod: ## Build and start production containers
	docker compose up --build -d

prod-down: ## Stop production containers
	docker compose down

# ── Run commands inside dev container ───────────────────────────────

DC_DEV = docker compose -f docker-compose.dev.yml
RUN    = $(DC_DEV) run --rm app

test: ## Run tests (in container)
	$(RUN) npm test

lint: ## Run linting and type-checking (in container)
	$(RUN) sh -c 'npm run lint && npx tsc --noEmit'

format: ## Format code (in container)
	$(RUN) npx prettier --write .

format-check: ## Check code formatting (in container)
	$(RUN) npx prettier --check .

ci: format-check lint test ## Run all CI checks (format, lint, test)

# ── Local (without Docker) ──────────────────────────────────────────

install: ## Install dependencies locally (no Docker)
	npm ci
	npx prisma generate

hooks: ## Set up Git pre-commit hooks (Husky + lint-staged)
	npx husky init
	cp .husky-pre-commit .husky/pre-commit
	chmod +x .husky/pre-commit

build: ## Build for production (in container)
	$(RUN) npm run build

clean: ## Remove build artifacts and dependencies
	rm -rf node_modules .next dist build coverage
