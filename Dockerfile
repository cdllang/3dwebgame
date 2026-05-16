FROM node:20-alpine AS builder

RUN npm config set registry https://registry.npmmirror.com

WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npx vite build

FROM node:20-alpine

RUN npm config set registry https://registry.npmmirror.com \
    && npm install -g serve

WORKDIR /app
COPY --from=builder /app/dist ./dist

EXPOSE 3000
CMD ["serve", "-s", "dist", "-l", "3000"]
