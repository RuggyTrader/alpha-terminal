# ALPHA TERMINAL backend (PAPER ONLY)
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY alpha_terminal ./alpha_terminal

RUN useradd --create-home --uid 10001 app && mkdir -p /data && chown app:app /data
USER app

EXPOSE 8000
# One worker on purpose: SQLite, the execution lock and rate limiter are per-process.
CMD ["python", "-m", "uvicorn", "alpha_terminal.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
