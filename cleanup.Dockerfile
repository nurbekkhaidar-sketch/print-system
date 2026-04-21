FROM node:20-alpine
WORKDIR /app

RUN apk add --no-cache bash ca-certificates tzdata

# зависимости берём из корня репозитория
COPY package.json ./package.json
COPY package-lock.json ./package-lock.json
RUN npm ci --omit=dev --no-audit --no-fund

# cleanup script лежит в print-cloud/api/scripts
COPY print-cloud/api/scripts ./scripts

CMD ["sh", "-c", "while true; do node /app/scripts/cleanup_tmp_files.js; sleep 60; done"]
