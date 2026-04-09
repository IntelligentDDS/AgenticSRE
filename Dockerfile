FROM python:3.12-slim

WORKDIR /app

# Install system deps + kubectl
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        ca-certificates \
    && apt-get clean && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL "https://dl.k8s.io/release/v1.31.4/bin/linux/amd64/kubectl" \
       -o /usr/local/bin/kubectl \
    && chmod +x /usr/local/bin/kubectl

ENV PYTHONPATH=/app

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY agents/ ./agents/
COPY configs/ ./configs/
COPY memory/ ./memory/
COPY observability/ ./observability/
COPY orchestrator/ ./orchestrator/
COPY paradigms/ ./paradigms/
COPY tools/ ./tools/
COPY web_app/ ./web_app/
COPY main.py mcp_server.py ./

VOLUME ["/app/data", "/app/logs"]

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:8080/api/health || exit 1

CMD ["python", "-m", "uvicorn", "web_app.app:app", "--host", "0.0.0.0", "--port", "8080"]
