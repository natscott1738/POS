.DEFAULT_GOAL := help
SHELL := /bin/bash

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

install: ## Install all workspace dependencies
	npm install

keys: ## Generate the three secrets required by .env
	@echo "JWT_SECRET=$$(openssl rand -hex 32)"
	@echo "ENCRYPTION_KEY=$$(openssl rand -hex 32)"
	@echo "BACKUP_ENCRYPTION_KEY=$$(openssl rand -hex 32)"
	@echo "MPESA_CALLBACK_TOKEN=$$(openssl rand -hex 24)"
	@echo "PDQ_CALLBACK_TOKEN=$$(openssl rand -hex 24)"

build: ## Build every workspace
	npm run build

migrate: ## Apply database migrations
	npm run db:migrate -w @pos/api

seed: ## Load development data (refuses to run in production)
	npm run db:seed -w @pos/api

create-admin: ## Create the first admin in the running stack: make create-admin EMAIL=you@example.com
	@test -n "$(EMAIL)" || { echo "usage: make create-admin EMAIL=you@example.com [NAME=\"Full Name\"] [STAFF_CODE=ADM001]"; exit 1; }
	docker compose exec api node apps/api/dist/db/create-admin.js --email "$(EMAIL)" \
		$(if $(NAME),--name "$(NAME)") $(if $(STAFF_CODE),--staff-code "$(STAFF_CODE)")

generate: ## Regenerate SQL migrations from the schema (build first)
	npm run build -w @pos/api && npm run db:generate -w @pos/api

dev: ## Run API (:4000) and till (:5173) with hot reload
	npm run dev

dev-api: ## Run only the API
	npm run dev:api

dev-web: ## Run only the till
	npm run dev:web

verify: ## Run EVERY automated check (typecheck, tests, build, browser + offline)
	@./scripts/verify.sh

demo: ## Start everything in production mode so you can click through it
	@./scripts/demo.sh

test: ## Run unit and integration tests only
	npm run test -w @pos/api

e2e: ## Run browser and offline tests (needs `make demo` running elsewhere)
	npx playwright test --config apps/web/playwright.config.ts

typecheck: ## Typecheck every workspace
	npm run typecheck

audit: ## Check dependencies for known vulnerabilities
	npm audit --audit-level=high

up: ## Start the Docker stack
	docker compose up -d --build

down: ## Stop the Docker stack
	docker compose down

logs: ## Tail API logs
	docker compose logs -f api

backup: ## Run a backup inside the running API container
	docker compose exec api node -e "import('./apps/api/dist/jobs/backup.js').then(m=>m.runBackup('MANUAL')).then(r=>console.log(r))"

.PHONY: help install keys build migrate seed create-admin generate dev dev-api dev-web verify demo test e2e typecheck audit up down logs backup
