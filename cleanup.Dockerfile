FROM node:20-alpine
WORKDIR /app

RUN apk add --no-cache bash ca-certificates tzdata

# ставим зависимости в /app (а не в /app/api)
COPY print-cloud/api/package*.json ./
RUN npm install --omit=dev

# скрипт cleanup
COPY print-cloud/api/scripts ./scripts

# бесконечный loop: cleanup раз в 60 секунд
CMD ["sh", "-c", "while true; do node /app/scripts/cleanup_tmp_files.js; sleep 60; done"]
