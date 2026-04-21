const { Client } = require("pg");
const fs = require("fs");
const path = require("path");

const STORAGE_TMP_DIR =
  process.env.STORAGE_TMP_DIR || "/opt/print-cloud/api/storage/tmp";

// Инвариант: cleanup НЕ трогает queued/reserved.
// Только финальные статусы.
const TTL_MINUTES = {
  completed: 5,
  failed: 360, // failed (paid) = 6 часов диагностики
};

function getTTL(status) {
  return TTL_MINUTES[status] ?? null;
}

function safeJoinTmp(fileName) {
  if (!fileName) return null;
  const base = path.basename(String(fileName)); // защита от path traversal
  return path.join(STORAGE_TMP_DIR, base);
}

async function cleanup() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  // Берём только финальные статусы и только те, где payload содержит поля для очистки.
  const res = await client.query(`
  SELECT
    id,
    status,
    created_at,
    updated_at,
    completed_at,
    failed_at,
    payload,
    result
  FROM jobs
  WHERE status IN ('completed','failed')
    AND (payload IS NOT NULL OR result IS NOT NULL)
  ORDER BY id ASC
`);

  const now = Date.now();
  let deleted = 0;
  let cleared = 0;

  for (const job of res.rows) {
    const ttlMin = getTTL(job.status);
    if (!ttlMin) continue;

    const baseTime = job.completed_at || job.failed_at || job.created_at;
    const ageMs = now - new Date(baseTime).getTime();
    if (ageMs < ttlMin * 60 * 1000) continue;

    const payload = job.payload || {};
    const kind = payload.kind || "print";

    // 1) удалить tmp-файлы (payload.fileName И result.fileRef)
    const result = job.result || {};

    const payloadFileName = payload.fileName;
    const resultFileRef = result.fileRef;

    const filePathFromPayload = safeJoinTmp(payloadFileName);
    const filePathFromResult = safeJoinTmp(resultFileRef);

    for (const filePath of [filePathFromPayload, filePathFromResult]) {
      if (!filePath) continue;

      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          deleted++;
        }
      } catch (e) {
        console.error(`[cleanup] delete failed ${filePath}: ${e.message}`);
      }
    }

    // 2) привести payload к строго { kind } (RFC)
    try {
      const upd = await client.query(
        `
        UPDATE jobs
        SET payload = $1::jsonb,
            updated_at = NOW()
        WHERE id = $2
        `,
        [JSON.stringify({ kind }), job.id]
      );

      if (upd.rowCount > 0) cleared += upd.rowCount;
    } catch (e) {
      console.error(`[cleanup] update failed job=${job.id}: ${e.message}`);
    }
  }

  console.log(`[cleanup] files deleted: ${deleted}, payload cleared: ${cleared}`);
  await client.end();
}

cleanup().catch((err) => {
  console.error("[cleanup] fatal:", err);
  process.exit(1);
});