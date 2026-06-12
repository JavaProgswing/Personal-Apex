FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV APEX_SYNC_DB=/data/apex_sync.sqlite

WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY apex_sync_api.py /app/apex_sync_api.py
COPY web_app.html /app/web_app.html
RUN mkdir -p /data

EXPOSE 8787
CMD ["sh", "-c", "uvicorn apex_sync_api:app --host 0.0.0.0 --port ${SERVER_PORT:-${APEX_SYNC_PORT:-8787}}"]
