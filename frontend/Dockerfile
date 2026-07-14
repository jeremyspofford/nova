FROM node:20-alpine AS base

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# dev: vite dev server with HMR (the compose `frontend` service)
FROM base AS dev
EXPOSE 5173
CMD ["npm", "run", "dev"]

# prod: built PWA behind nginx, same-origin /api proxy (the `web` service)
FROM base AS build
RUN npm run build

FROM nginx:alpine AS web
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
