#!/bin/sh
# Starts OpenFGA with an in-memory store, loads the model and seed tuples, then starts the app.
# Everything resets to the seed data whenever the container restarts.
set -e

openfga run \
  --datastore-engine memory \
  --http-addr 127.0.0.1:8080 \
  --grpc-addr 127.0.0.1:8081 \
  --playground-enabled=false \
  --metrics-enabled=false \
  --log-level warn &

until wget -q -O /dev/null http://127.0.0.1:8080/healthz; do sleep 1; done

cd app
node scripts/setup.js
exec node src/server.js
