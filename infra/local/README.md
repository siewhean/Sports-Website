# Local dependencies

Start PostgreSQL, Redis, Mailpit, and the OpenTelemetry Collector:

```sh
docker compose -f infra/local/compose.yaml up -d --wait
pnpm db:migrate
```

Mailpit is available at `http://127.0.0.1:8025`. Local credentials are intentionally non-secret and must never be reused outside local development.

The OpenTelemetry Collector is opt-in so a collector/image-runtime issue cannot block the database, queue, or email development loop:

```sh
docker compose -f infra/local/compose.yaml --profile telemetry up -d --wait
```

Its OTLP HTTP endpoint is `http://127.0.0.1:4318` and health endpoint is `http://127.0.0.1:13133`. Set `OTEL_ENABLED=true` and `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318` for local export.

The Collector accepts OTLP/HTTP at `http://127.0.0.1:4318`, OTLP/gRPC at `127.0.0.1:4317`, and exposes its health endpoint at `http://127.0.0.1:13133`. To inspect local API telemetry, set `OTEL_ENABLED=true`; the example endpoint already targets this collector. The local debug exporter writes received trace and metric summaries to the Collector logs:

```sh
docker compose -f infra/local/compose.yaml logs -f otel-collector
```

Stop services without deleting data:

```sh
docker compose -f infra/local/compose.yaml down
```
