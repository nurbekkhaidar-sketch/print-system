FROM node:20-alpine
WORKDIR /app

RUN apk add --no-cache bash ca-certificates tzdata

# ставим зависимости в /app (а не в /app/api)
COPY print-cloud/api/package*.json ./
RUN node -v && npm -v
RUN ls -la
RUN test -f package.json && echo "package.json present"
RUN test -f package-lock.json && echo "package-lock.json present" || (echo "package-lock.json missing" && exit 1)
RUN npm ci --omit=dev --no-audit --no-fund

# скрипт cleanup
COPY print-cloud/api/scripts ./scripts

# бесконечный loop: cleanup раз в 60 секунд
CMD ["sh", "-c", "while true; do node /app/scripts/cleanup_tmp_files.js; sleep 60; done"]
