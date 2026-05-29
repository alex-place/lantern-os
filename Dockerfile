FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    LANTERN_GARAGE_HOST=0.0.0.0 \
    LANTERN_GARAGE_PORT=4177

COPY . .
EXPOSE 4177
CMD ["node", "apps/lantern-garage/server.js"]
