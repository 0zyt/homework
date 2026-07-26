FROM node:22-alpine
RUN apk add --no-cache docker-cli
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY server.mjs .
COPY public/ public/
EXPOSE 3456
CMD ["node", "server.mjs"]
