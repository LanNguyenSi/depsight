.PHONY: install hooks dev dev-up dev-down dev-logs dev-ps prod prod-down backup restore build test lint format ci clean help

.DEFAULT_GOAL := help

# Dev compose command. -p beats COMPOSE_PROJECT_NAME from .env, so the dev stack
# (project depsight-dev, volume depsight-dev_postgres_data) can never share a
# project or a database volume with the production stack, even in a production
# checkout. Defined before the first use: recipes expand it when they run.
DC_DEV = docker compose -p depsight-dev -f docker-compose.dev.yml

help: ## Show this help message
	@echo 'Usage: make [target]'
	@echo ''
	@echo 'Available targets:'
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  %-15s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# ── Development (Docker) ────────────────────────────────────────────

dev: ## Start dev environment (installs deps, pushes DB schema, starts server)
	$(DC_DEV) up --build

dev-up: ## Start dev environment in background
	$(DC_DEV) up --build -d

dev-down: ## Stop dev environment
	$(DC_DEV) down

dev-logs: ## Tail dev logs
	$(DC_DEV) logs -f

dev-ps: ## Show running dev containers
	$(DC_DEV) ps

dev-clean: ## Stop dev environment and remove volumes
	$(DC_DEV) down -v

# ── Production (Docker) ─────────────────────────────────────────────

prod: ## Build and start production containers
	docker compose up --build -d

prod-down: ## Stop production containers
	docker compose down

# ── Backup and restore (hosted stack, docker-compose.traefik.yml) ───

backup: ## Dump the hosted Postgres into backups/ (see docs/configuration.md, Backup and restore)
	scripts/backup.sh

restore: ## Restore a dump: make restore FILE=backups/depsight-<ts>.sql CONFIRM=yes [NO_PRE_BACKUP=yes] (destructive)
	scripts/restore.sh $(if $(filter yes,$(CONFIRM)),--yes) $(if $(filter yes,$(NO_PRE_BACKUP)),--no-pre-backup) $(FILE)

# ── Run commands inside dev container ───────────────────────────────

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
