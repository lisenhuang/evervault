COMPOSE     = docker compose
COMPOSE_DEV = docker compose -f docker-compose.yml -f docker-compose.dev.yml
SERVICE     = app

.PHONY: dev up down logs build sh clean rebuild help

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-9s\033[0m %s\n", $$1, $$2}'

dev: ## Dev with hot reload (edit & save, no rebuild)
	$(COMPOSE_DEV) up --build

up: ## Build + run the prod image (detached) on :38378
	$(COMPOSE) up --build -d

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

rebuild: clean build ## Clean then rebuild the prod image
