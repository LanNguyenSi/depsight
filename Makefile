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

# ── Local (without Docker) ──────────────────────────────────────────

install: ## Install dependencies (local, no Docker)
	npm ci
	npx prisma generate

hooks: ## Set up Git pre-commit hooks (Husky + lint-staged)
	npx husky init
	cp .husky-pre-commit .husky/pre-commit
	chmod +x .husky/pre-commit

build: ## Build for production
	npm run build

test: ## Run tests
	npm test

lint: ## Run linting and type-checking
	npm run lint
	npm run type-check

format: ## Format code
	npm run format

format-check: ## Check code formatting
	npm run format:check

ci: format-check lint test build ## Run all CI checks (format, lint, test, build)

clean: ## Remove build artifacts and dependencies
	rm -rf node_modules .next dist build coverage
