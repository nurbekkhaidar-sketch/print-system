FROM node:20-alpine
WORKDIR /app

RUN apk add --no-cache bash ca-certificates tzdata

# зависимости берём из print-cloud
COPY print-cloud/package.json ./package.json
COPY print-cloud/package-lock.json ./package-lock.json
RUN npm ci --omit=dev --no-audit --no-fund

# сам cleanup-скрипт лежит в print-cloud/api/scripts
COPY print-cloud/api/scripts ./scripts

# бесконечный loop: cleanup раз в 60 секунд
CMD ["sh", "-c", "while true; do node /app/scripts/cleanup_tmp_files.js; sleep 60; done"]
