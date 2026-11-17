.PHONY: install hooks dev dev-up dev-down dev-logs dev-ps dev-clean prod prod-down backup restore backup-selfhost restore-selfhost build test lint format format-check ci clean help

.DEFAULT_GOAL := help

# Dev compose command. -p beats COMPOSE_PROJECT_NAME from .env, so the dev stack
# (project depsight-dev, volume depsight-dev_postgres_data) can never share a
# project or a database volume with the production stack, even in a production
# checkout. Defined before the first use: recipes expand it when they run.
DC_DEV = docker compose -p depsight-dev -f docker-compose.dev.yml

# Prod compose command. -f pins the file, so a COMPOSE_FILE in .env cannot silently point
# make prod at another compose file, and a docker-compose.override.yml is no longer merged.
# No -p on purpose: the project name must still come from .env (COMPOSE_PROJECT_NAME, see
# docs/configuration.md, Self-hosting), so an older install keeps its database volume.
DC_PROD = docker compose -f docker-compose.yml

# Guard for the targets that act on the production project (prod, prod-down). docker-compose.yml
# and docker-compose.traefik.yml (the hosted instance's file) both pin `name: depsight`, so on
# the hosted host they are the SAME project: make prod would recreate the live containers
# without their Traefik labels and networks (public routes answer 404) and make prod-down would
# remove them. The helper reads the compose labels Docker recorded on the containers of the
# project, running or stopped, and refuses, before anything changes, unless they were created
# from docker-compose.yml (a stack that also uses docker-compose.override.yml passes; a stack
# whose files include docker-compose.traefik.yml is refused, --other-prod; exit 2).
# No container, or the same file, passes. FORCE=1 (or yes) on the make command line skips it,
# for the rare case you mean it: `make prod FORCE=1`; a FORCE in the shell environment is
# ignored. The same variable is passed on to backup.sh and restore.sh. Recovery after a make
# prod on the hosted host: docker compose -f docker-compose.traefik.yml up -d
GUARD_PROD = scripts/check-running-stack.sh --other-prod docker-compose.traefik.yml docker-compose.yml
ifeq ($(origin FORCE),command line)
ifneq ($(filter 1 yes,$(FORCE)),)
export COMPOSE_GUARD_FORCE := 1
endif
endif

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

prod: ## Build and start production containers (self-hosting file; refuses on the hosted host, see FORCE=1)
	$(GUARD_PROD)
	$(DC_PROD) up --build -d

prod-down: ## Stop production containers (self-hosting file; refuses on the hosted host, see FORCE=1)
	$(GUARD_PROD)
	$(DC_PROD) down

# ── Backup and restore (hosted stack, docker-compose.traefik.yml; *-selfhost: docker-compose.yml) ───

backup: ## Dump the hosted Postgres into backups/ (see docs/configuration.md, Backup and restore)
	scripts/backup.sh

restore: ## Restore a dump: make restore FILE=backups/depsight-<ts>.sql CONFIRM=yes [NO_PRE_BACKUP=yes] (destructive)
	scripts/restore.sh $(if $(filter yes,$(CONFIRM)),--yes) $(if $(filter yes,$(NO_PRE_BACKUP)),--no-pre-backup) $(FILE)

backup-selfhost: ## Dump the self-hosting Postgres (docker-compose.yml) into backups/
	BACKUP_COMPOSE_FILE=docker-compose.yml scripts/backup.sh

restore-selfhost: ## Restore on the self-hosting stack: make restore-selfhost FILE=... CONFIRM=yes [NO_PRE_BACKUP=yes]; no schema step, apply it after (destructive)
	BACKUP_COMPOSE_FILE=docker-compose.yml RESTORE_MIGRATE_SERVICE= scripts/restore.sh $(if $(filter yes,$(CONFIRM)),--yes) $(if $(filter yes,$(NO_PRE_BACKUP)),--no-pre-backup) $(FILE)

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
