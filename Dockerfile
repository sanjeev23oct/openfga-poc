# Single container for free hosting: OpenFGA (in-memory store) plus the HR API and UI.
# For local development use docker-compose.yml, which runs OpenFGA with Postgres.
FROM openfga/openfga:v1.22.0 AS openfga

FROM node:22-alpine
COPY --from=openfga /openfga /usr/local/bin/openfga
WORKDIR /srv
COPY app/package.json app/package-lock.json ./app/
RUN cd app && npm ci --omit=dev
COPY fga ./fga
COPY app ./app
COPY deploy/start.sh ./start.sh
ENV PORT=4000
EXPOSE 4000
CMD ["sh", "./start.sh"]
