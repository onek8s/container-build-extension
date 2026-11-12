# npm install runs through safe-chain (injected by the action); the final image has no OS packages
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM scratch
COPY --from=deps /app/node_modules /app/node_modules
COPY hello.txt /hello.txt
