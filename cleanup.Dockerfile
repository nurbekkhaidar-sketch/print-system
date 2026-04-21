FROM node:20-alpine
WORKDIR /app

RUN apk add --no-cache bash ca-certificates tzdata

# зависимости берём из api
COPY api/package.json ./package.json
COPY api/package-lock.json ./package-lock.json
RUN npm ci --omit=dev --no-audit --no-fund

# cleanup script
COPY api/scripts ./scripts

# бесконечный loop: cleanup раз в 60 секунд
CMD ["sh", "-c", "while true; do node /app/scripts/cleanup_tmp_files.js; sleep 60; done"]
