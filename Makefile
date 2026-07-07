# google-search — Makefile
# Run `make` or `make help` to see all commands.

PORT       ?= 3000
HOST       ?= 0.0.0.0
LIMIT      ?= 10
PM         ?= pnpm

DIST_API   := dist/src/api-server.js
DIST_CLI   := dist/src/index.js
DIST_MCP   := dist/src/mcp-server.js
PID_FILE   := .api.pid
LOG_FILE   := /tmp/google-search-api.log
HEALTH_URL := http://127.0.0.1:$(PORT)/health

.DEFAULT_GOAL := help
.PHONY: help install build dev start stop restart status logs search cli mcp harvest clean

help: ## Show this help
	@echo "google-search — available commands:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "Variables: PORT=$(PORT) HOST=$(HOST) LIMIT=$(LIMIT)  (override e.g. 'make start PORT=8080')"

install: ## Install dependencies and the Chromium browser
	$(PM) install
	npx playwright install chromium

build: ## Compile TypeScript to dist/
	$(PM) run build

dev: ## Run the API in the foreground (ts-node), Ctrl+C to stop
	PORT=$(PORT) HOST=$(HOST) $(PM) run api

start: build ## Build, then start the API in the background (detached)
	@if [ -f $(PID_FILE) ] && kill -0 `cat $(PID_FILE)` 2>/dev/null; then \
		echo "API already running (pid `cat $(PID_FILE)`) at http://$(HOST):$(PORT)"; \
	else \
		PORT=$(PORT) HOST=$(HOST) nohup node $(DIST_API) > $(LOG_FILE) 2>&1 & echo $$! > $(PID_FILE); \
		printf "Starting google-search API"; \
		for i in $$(seq 1 30); do \
			if curl -sf $(HEALTH_URL) >/dev/null 2>&1; then break; fi; \
			printf "."; sleep 1; \
		done; \
		if curl -sf $(HEALTH_URL) >/dev/null 2>&1; then \
			echo " -> ready at http://$(HOST):$(PORT) (pid `cat $(PID_FILE)`)"; \
			echo "Logs: $(LOG_FILE)  |  Stop: make stop"; \
		else \
			echo " FAILED to become healthy — see $(LOG_FILE)"; rm -f $(PID_FILE); exit 1; \
		fi; \
	fi

stop: ## Stop the background API
	@if [ -f $(PID_FILE) ] && kill -0 `cat $(PID_FILE)` 2>/dev/null; then \
		kill `cat $(PID_FILE)` && echo "Stopped API (pid `cat $(PID_FILE)`)"; \
		rm -f $(PID_FILE); \
	else \
		pkill -f "$(DIST_API)" 2>/dev/null && echo "Stopped API (via pkill)" || echo "API not running"; \
		rm -f $(PID_FILE); \
	fi

restart: stop start ## Restart the background API

status: ## Check whether the API is healthy
	@curl -sf $(HEALTH_URL) && echo "" \
		|| { echo "API is DOWN at http://$(HOST):$(PORT) — run 'make start'"; exit 1; }

logs: ## Tail the API log
	@touch $(LOG_FILE) && tail -f $(LOG_FILE)

search: ## Search via the running API. Usage: make search Q="your query" [LIMIT=10]
	@if [ -z "$(Q)" ]; then echo 'Usage: make search Q="your query" [LIMIT=10]'; exit 1; fi
	@curl -s -G "http://127.0.0.1:$(PORT)/search" \
		--data-urlencode "q=$(Q)" --data-urlencode "limit=$(LIMIT)" \
		| node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.stringify(JSON.parse(d),null,2))}catch(e){console.log(d)}})'

cli: build ## Run the CLI directly. Usage: make cli Q="your query" [LIMIT=10]
	@if [ -z "$(Q)" ]; then echo 'Usage: make cli Q="your query" [LIMIT=10]'; exit 1; fi
	@node $(DIST_CLI) "$(Q)" --limit $(LIMIT)

mcp: build ## Run the MCP server (stdio)
	@node $(DIST_MCP)

harvest: ## Run theHarvester via the google source (auto-starts the API). Usage: make harvest D=example.com [LIMIT=20]
	@if [ -z "$(D)" ]; then echo 'Usage: make harvest D=example.com [LIMIT=20]'; exit 1; fi
	@$(MAKE) --no-print-directory start
	theHarvester -d $(D) -b google -l $(LIMIT)

clean: ## Remove build output
	@rm -rf dist && echo "Removed dist/"
