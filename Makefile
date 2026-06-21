.PHONY: test test-dream build-dream up-dream down-dream logs-dream pull-dream-model check-node convergence quickstart

test:
	python -m pytest tests -q

test-dream:
	python -m pytest tests/test_fallacy_detector.py tests/test_audit_chain.py tests/test_anti_entropy_memory.py -q

build-dream:
	docker compose -f docker-compose.dream-journal.yml build

up-dream:
	docker compose -f docker-compose.dream-journal.yml up -d

down-dream:
	docker compose -f docker-compose.dream-journal.yml down

logs-dream:
	docker compose -f docker-compose.dream-journal.yml logs -f dream-journal

pull-dream-model:
	docker compose -f docker-compose.dream-journal.yml exec ollama ollama pull $${OLLAMA_MODEL:-llama3.2}

check-node:
	cd apps/lantern-garage && npm run check

convergence:
	pwsh -NoProfile -ExecutionPolicy Bypass -File ./scripts/Invoke-LanternConvergenceLoop.ps1 -Root . -Output manifests/evidence/convergence-local.json -CloudVirtualization

quickstart:
	@echo ""
	@echo "📚 REQUIRED READING:"
	@echo "   Before starting, read:"
	@echo "   • QUICKSTART.md — how to run both servers"
	@echo "   • AGENTS.md — workflow and git rules"
	@echo ""
	pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/Start-DualServers.ps1

quickstart-no-browser:
	pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/Start-DualServers.ps1 -NoChrome

dev:
	npm run dev --prefix apps/lantern-garage

stop: stop-services

stop-services:
	pwsh -NoProfile -Command "foreach ($$p in 4177,4178,11434) { Get-NetTCPConnection -LocalPort $$p -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $$_ -Force -ErrorAction SilentlyContinue } }"
