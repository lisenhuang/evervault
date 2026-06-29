COMPOSE     = docker compose
COMPOSE_DEV = docker compose -f docker-compose.yml -f docker-compose.dev.yml
SERVICE     = app

.PHONY: dev up down logs build sh clean prune rebuild reset-admin help

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-9s\033[0m %s\n", $$1, $$2}'

dev: ## Dev with hot reload (edit & save, no rebuild)
	@echo "🔥 Starting dev — ready at 👉 http://localhost:38378 once compiled (watch the logs)"
	$(COMPOSE_DEV) up --build

up: ## Build + run prod (detached), drop old versions, wait until ready, print URL
	$(COMPOSE) up --build -d
	@echo "🧹 Removing old EverVault image versions..."
	@docker image prune -f --filter "label=app=evervault" >/dev/null 2>&1 || true
	@port=$${HOST_PORT:-$$(grep -E '^HOST_PORT=' .env 2>/dev/null | cut -d= -f2)}; \
	port=$${port:-38378}; \
	url="http://localhost:$$port"; \
	printf "⏳ Waiting for EverVault to be ready"; \
	for i in $$(seq 1 60); do \
		if curl -fsS -o /dev/null "$$url/api/health" 2>/dev/null && curl -fsS -o /dev/null "$$url/" 2>/dev/null; then \
			printf "\n✅ EverVault is ready 👉 %s\n" "$$url"; exit 0; \
		fi; \
		printf "."; sleep 2; \
	done; \
	printf "\n⚠️  Timed out waiting for readiness. Check: make logs\n"; exit 1

down: ## Stop & remove the container
	$(COMPOSE_DEV) down

logs: ## Tail logs
	$(COMPOSE) logs -f $(SERVICE)

build: ## Build the prod image only
	$(COMPOSE) build

sh: ## Shell into the running container
	$(COMPOSE) exec $(SERVICE) bash

clean: ## Tear down + drop volumes/images (forces fresh install)
	$(COMPOSE_DEV) down -v --remove-orphans
	-docker image rm evervault-app:dev evervault-app:prod 2>/dev/null || true

prune: ## Reclaim disk: remove dangling images + ALL build cache
	docker image prune -f
	docker builder prune -f

reset-admin: ## Delete the admin account(s) → /admin shows first-run setup again (stack must be running)
	$(COMPOSE) exec -T db psql -U postgres -d evervault -c 'DELETE FROM "Admins";'
	@echo "✅ Admin cleared. Open /admin to create a new account."

rebuild: clean build ## Clean then rebuild the prod image
