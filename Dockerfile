# syntax = docker/dockerfile:1

ARG NODE_VERSION=22
ARG ENVIRONMENT=production

FROM node:${NODE_VERSION}-slim AS base
COPY ZscalerRoot-FullBundle.pem /usr/local/share/ca-certificates/ZscalerRoot-FullBundle.pem
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/ZscalerRoot-FullBundle.pem

# App lives here
WORKDIR /app

# Set production environment
ENV NODE_ENV=production
ARG YARN_VERSION=1.22.21
RUN npm install -g yarn@$YARN_VERSION --force

# Throw-away build stage to reduce size of final image
FROM base AS build

# Install packages needed to build node modules
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y build-essential node-gyp openssl pkg-config python-is-python3

# Install node modules
COPY package.json yarn.lock ./
COPY prisma.config.ts ./
COPY prisma ./prisma
# Dummy value so prisma generate (postinstall) can resolve the env var during build.
# The real connection string is provided at runtime via docker-compose.
ENV JETSTREAM_POSTGRES_DBURI=postgres://build:build@localhost:5432/postgres
RUN yarn install --frozen-lockfile --production=false

# Generate Prisma Client
COPY prisma .
RUN yarn run db:generate

# Copy application code
COPY . .

# Build application
RUN yarn build:core && \
    yarn build:landing && \
    # Replace dependencies with only the ones required by API
    yarn scripts:replace-deps && \
    rm -rf .nx

# Remove development dependencies and unused prod dependencies.
# Prisma client was already generated earlier, so skip the postinstall hook
# (prisma CLI is a devDependency and gets removed by --production=true).
RUN yarn install --production=true --ignore-scripts && \
    yarn add --ignore-scripts cross-env npm-run-all --save-dev && \
    yarn add --ignore-scripts prisma tsx

# FIXME: figure out why this is not included
# Add missing dependencies
RUN yarn add --ignore-scripts @react-email/components

# Final stage for app image
FROM base

# Install packages needed for deployment
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y openssl && \
    rm -rf /var/lib/apt/lists /var/cache/apt/archives

RUN npm install -g ts-node@10.9.1

# Copy built application
COPY --from=build /app /app

# Start the server by default, this can be overwritten at runtime
EXPOSE 3333
CMD [ "yarn", "run", "start:prod" ]
