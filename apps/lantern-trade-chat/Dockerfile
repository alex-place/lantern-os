# Lantern Trade Chat — OAuth-gated Kalshi order desk.
FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Build needs the package dir present (pyproject declares packages = ["app"]).
COPY pyproject.toml ./
COPY app ./app
RUN pip install --upgrade pip && pip install .

# Static assets (served at runtime).
COPY static ./static

# Non-root runtime user.
RUN useradd --create-home --uid 10001 lantern && chown -R lantern:lantern /app
USER lantern

EXPOSE 8080

# Safe defaults: demo environment, live trading disabled. Override at deploy time.
ENV KALSHI_ENVIRONMENT=demo \
    LANTERN_LIVE_ENABLED=0

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/api/health').status==200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
