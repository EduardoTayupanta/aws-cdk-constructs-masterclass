# syntax=docker/dockerfile:1

# ---- Build stage: install deps and bundle the TypeScript handler ----
# A plain Node image, not the Lambda base image — esbuild and the dev
# dependencies below never need to exist in the deployed image.
FROM public.ecr.aws/docker/library/node:22-slim AS build
WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci

COPY index.ts ./
RUN npm run bundle

# ---- Runtime stage: AWS's own Lambda Node.js base image ----
# Only the single bundled JS file crosses into the final image: no
# node_modules, no TypeScript source, no build tooling.
FROM public.ecr.aws/lambda/nodejs:22
COPY --from=build /build/index.js ${LAMBDA_TASK_ROOT}/index.js
CMD ["index.handler"]
