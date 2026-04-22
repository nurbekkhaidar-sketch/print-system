const express = require('express');
const { Pool } = require('pg');
const filesRouter = require('./routes/files');

const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

process.on("unhandledRejection", (err) => {
  console.error("[FATAL] unhandledRejection", err);
});
process.on("uncaughtException", (err) => {
  console.error("[FATAL] uncaughtException", err);
});

const app = express();
app.use(express.json({
  limit: '2mb',
  strict: true
}));

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error('[JSON_PARSE_ERROR]', err.message);
    return res.status(400).json({ ok: false, error: 'invalid_json' });
  }
  next(err);
});

const errorMiddleware = (err, req, res, next) => {
  console.error("[HTTP_ERROR]", {
    url: req.originalUrl,
    method: req.method,
    message: err?.message,
    stack: err?.stack,
  });
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, error: "internal_error" });
};

const port = Number(process.env.API_PORT || 3000);

/** Single-line JSON log for job lifecycle. No debug logs. */
function logLifecycle(payload) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...payload }));
}

function parseAgentsEnv(value) {
  const map = new Map();
  if (!value) return map;
  const pairs = value.split(',').map(s => s.trim()).filter(Boolean);
  for (const p of pairs) {
    const idx = p.indexOf(':');
    if (idx <= 0) continue;
    const printerId = p.slice(0, idx).trim();
    const token = p.slice(idx + 1).trim();
    if (printerId && token) map.set(printerId, token);
  }
  return map;
}

const AGENTS = parseAgentsEnv(process.env.AGENTS);

function requireAgentAuth(req, res, next) {
  const auth = req.header('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ ok: false, error: 'missing_bearer_token' });

  const token = m[1].trim();
  const printerId = String(req.query.printerId || '').trim();
  if (!printerId) return res.status(400).json({ ok: false, error: 'missing_printerId' });

  const expected = AGENTS.get(printerId);
  if (!expected) return res.status(403).json({ ok: false, error: 'unknown_printerId' });
  if (token !== expected) return res.status(403).json({ ok: false, error: 'invalid_token_for_printer' });

  req.printerId = printerId;
  next();
}

function requireAdminAuth(req, res, next) {
  const auth = req.header('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ ok: false, error: 'missing_bearer_token' });

  const token = m[1].trim();
  const expected = String(process.env.ADMIN_TOKEN || '').trim();
  if (!expected) return res.status(500).json({ ok: false, error: 'admin_token_not_configured' });
  if (token !== expected) return res.status(403).json({ ok: false, error: 'invalid_admin_token' });

  next();
}

// Portal auth: if PORTAL_TOKEN is set, portal endpoints accept PORTAL_TOKEN and we allow ADMIN_TOKEN
// for pilot flexibility; if PORTAL_TOKEN is not set, only ADMIN_TOKEN is accepted (pilot fallback).
const PORTAL_TOKEN = String(process.env.PORTAL_TOKEN || '').trim();

function requirePortalAuth(req, res, next) {
  const auth = req.header('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ ok: false, error: 'missing_bearer_token' });

  const token = m[1].trim();
  const adminToken = String(process.env.ADMIN_TOKEN || '').trim();
  const portalToken = PORTAL_TOKEN;
  const valid = (adminToken && token === adminToken) || (portalToken && token === portalToken);
  if (!valid) return res.status(403).json({ ok: false, error: 'invalid_portal_token' });

  next();
}

const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'db',
  port: Number(process.env.POSTGRES_PORT || 5432),
  database: process.env.POSTGRES_DB || 'print',
  user: process.env.POSTGRES_USER || 'print',
  password: process.env.POSTGRES_PASSWORD || 'print_secret'
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS jobs (
      id            BIGSERIAL PRIMARY KEY,
      status        TEXT NOT NULL CHECK (status IN ('queued','reserved','completed','failed')),
      printer_id    TEXT,
      lease_until   TIMESTAMPTZ,
      attempt       INT NOT NULL DEFAULT 0,
      payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
      result        JSONB,
      error         JSONB,
      completed_at  TIMESTAMPTZ,
      failed_at     TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_lease_until ON jobs(lease_until);

    CREATE TABLE IF NOT EXISTS copy_sessions (
      id                         TEXT PRIMARY KEY,
      status                     TEXT NOT NULL,
      scan_job_id                BIGINT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE RESTRICT,
      print_job_id               BIGINT REFERENCES jobs(id) ON DELETE RESTRICT,

      payment_status             TEXT NOT NULL,
      payment_intent_id          TEXT,
      payment_confirmed_at       TIMESTAMPTZ,

      pages                      INT,
      price                      INT,
      currency                   TEXT,

      artifact_file_ref          TEXT,
      artifact_file_url          TEXT,
      artifact_uploaded_at       TIMESTAMPTZ,
      artifact_retention_deadline TIMESTAMPTZ,

      error_code                 TEXT,
      error_message              TEXT,
      kiosk_id                   TEXT,
      printer_id                 TEXT,

      idempotency_key            TEXT,

      created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_copy_sessions_print_job_id_unique
      ON copy_sessions(print_job_id)
      WHERE print_job_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_copy_sessions_idempotency_key_unique
      ON copy_sessions(idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_copy_sessions_status ON copy_sessions(status);
    CREATE INDEX IF NOT EXISTS idx_copy_sessions_payment_status ON copy_sessions(payment_status);
    CREATE INDEX IF NOT EXISTS idx_copy_sessions_artifact_retention_deadline ON copy_sessions(artifact_retention_deadline);
    CREATE INDEX IF NOT EXISTS idx_copy_sessions_created_at ON copy_sessions(created_at);
    CREATE INDEX IF NOT EXISTS idx_copy_sessions_updated_at ON copy_sessions(updated_at);

    CREATE TABLE IF NOT EXISTS payment_intents (
      id              TEXT PRIMARY KEY,
      copy_session_id TEXT NOT NULL REFERENCES copy_sessions(id) ON DELETE CASCADE,
      provider_name   TEXT,
      provider_ref    TEXT,
      amount          INT,
      currency        TEXT,
      status          TEXT NOT NULL,
      idempotency_key TEXT,
      confirmed_at    TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_intents_idempotency_key_unique
      ON payment_intents(idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_intents_provider_ref_unique
      ON payment_intents(provider_ref)
      WHERE provider_ref IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_payment_intents_copy_session_id ON payment_intents(copy_session_id);
    CREATE INDEX IF NOT EXISTS idx_payment_intents_status ON payment_intents(status);
  `);
}

function nowIso() {
  return new Date().toISOString();
}

async function reserveNextJob(printerId, leaseSeconds = 60) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const pick = await client.query(`
      SELECT id
      FROM jobs
      WHERE
        (status = 'queued')
        OR (status = 'reserved' AND lease_until IS NOT NULL AND lease_until <= now())
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `);

    if (pick.rowCount === 0) {
      await client.query('COMMIT');
      return null;
    }

    const jobId = pick.rows[0].id;
    const upd = await client.query(
      `
        UPDATE jobs
        SET
          status = 'reserved',
          printer_id = $1,
          lease_until = now() + ($2::int * interval '1 second'),
          attempt = attempt + 1,
          updated_at = now()
        WHERE id = $3
        RETURNING *
      `,
      [printerId, leaseSeconds, jobId]
    );

    await client.query('COMMIT');
    return upd.rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

const TMP_DIR = path.join(__dirname, 'storage', 'tmp');
fs.mkdirSync(TMP_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, TMP_DIR),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname || '') || '.bin').toLowerCase();
      const id = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
      cb(null, `scan_${Date.now()}_${id}${ext}`);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 }
});

const uploadPrint = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, TMP_DIR),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname || '') || '.pdf').toLowerCase();
      const id = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
      cb(null, `print_${Date.now()}_${id}${ext}`);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 }
});

app.get('/api/agent/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.get('/api/agent/auth/ping', requireAgentAuth, (req, res) => {
  res.json({ ok: true, printerId: req.printerId, ts: Date.now() });
});

app.get('/api/agent/jobs/next', requireAgentAuth, async (req, res) => {
  try {
    const rawLease = Number(req.query.leaseSeconds ?? 60);
    const leaseSeconds = Number.isFinite(rawLease) ? Math.max(15, Math.min(300, rawLease)) : 60;

    const job = await reserveNextJob(req.printerId, leaseSeconds);
    if (!job) return res.status(204).send();
    logLifecycle({
      action: 'reserve',
      jobId: job.id,
      printer_id: job.printer_id,
      lease_until: job.lease_until ? String(job.lease_until) : null,
      attempt: job.attempt != null ? job.attempt : null,
      result_present: !!(job.result && (job.result.fileRef || job.result.fileUrl)),
    });
    res.json({ ok: true, job });
  } catch (e) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: 'jobs/next DB error', message: e?.message, code: e?.code }));
    return res.status(500).json({ ok: false, error: "db_error" });
  }
});

app.post('/api/agent/jobs/:id/complete', requireAgentAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: 'invalid_job_id' });
  }

  const result = req.body?.result ?? {};

  const { rows } = await pool.query('SELECT * FROM jobs WHERE id = $1', [id]);
  if (rows.length === 0) return res.status(404).json({ ok: false, error: 'job_not_found' });

  const job = rows[0];

  if (job.status === 'completed') {
    logLifecycle({ action: 'complete', jobId: id, printer_id: req.printerId, lease_until: job.lease_until ? String(job.lease_until) : null, attempt: job.attempt, result_present: true, idempotent: true });
    return res.json({ ok: true, job, idempotent: true });
  }
  if (job.status === 'failed') return res.status(409).json({ ok: false, error: 'job_already_failed' });

  if (job.status !== 'reserved' || job.printer_id !== req.printerId) {
    return res.status(409).json({ ok: false, error: 'job_not_reserved_by_this_printer' });
  }
  if (job.lease_until && new Date(job.lease_until) < new Date()) {
    logLifecycle({ action: 'complete', jobId: id, printer_id: req.printerId, lease_until: String(job.lease_until), attempt: job.attempt, result_present: false, error: 'lease_expired' });
    return res.status(409).json({ ok: false, error: 'lease_expired' });
  }

  // S2 guard: forbid completing scan jobs without fileRef/fileUrl
  const kind = job.payload?.kind;
  const isScan = typeof kind === 'string' && (kind === 'scan_glass' || kind === 'scan_adf' || kind.startsWith('scan_'));
  if (isScan) {
    const fileRef = result.fileRef;
    const fileUrl = result.fileUrl;
    if (typeof fileRef !== 'string' || !fileRef.trim()) {
      logLifecycle({ action: 'complete', jobId: id, printer_id: req.printerId, lease_until: job.lease_until ? String(job.lease_until) : null, attempt: job.attempt, result_present: false, error: 'file_ref_missing' });
      return res.status(400).json({ ok: false, error: 'file_ref_missing' });
    }
    if (typeof fileUrl !== 'string' || !fileUrl.trim()) {
      logLifecycle({ action: 'complete', jobId: id, printer_id: req.printerId, lease_until: job.lease_until ? String(job.lease_until) : null, attempt: job.attempt, result_present: false, error: 'file_url_missing' });
      return res.status(400).json({ ok: false, error: 'file_url_missing' });
    }
  }

  const upd = await pool.query(
    `
      UPDATE jobs
      SET status='completed',
          result = COALESCE(result, '{}'::jsonb) || $2::jsonb,
          completed_at=now(),
          lease_until=NULL,
          updated_at=now()
      WHERE id=$1
      RETURNING *
    `,
    [id, JSON.stringify(result)]
  );

  logLifecycle({ action: 'complete', jobId: id, printer_id: req.printerId, lease_until: job.lease_until ? String(job.lease_until) : null, attempt: job.attempt, result_present: true });

  // Phase 3: project scan result into copy_session (no side-effects on GET).
  try {
    const kind = upd.rows[0]?.payload?.kind;
    const isScan = typeof kind === 'string' && kind.startsWith('scan_');
    if (isScan) {
      const cs = await pool.query(`SELECT id FROM copy_sessions WHERE scan_job_id = $1 LIMIT 1`, [id]);
      if (cs.rowCount > 0) {
        const copySessionId = cs.rows[0].id;
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const r = await projectScanJobToCopySession(c, copySessionId);
          await c.query('COMMIT');
          console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'copy_session_projection_success', copySessionId, scanJobId: id, result: r }));
        } catch (e) {
          await c.query('ROLLBACK');
          console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', msg: 'copy_session_projection_failed', copySessionId, scanJobId: id, message: e?.message }));
        } finally {
          c.release();
        }
      }
    }
  } catch (e) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', msg: 'copy_session_projection_unexpected', scanJobId: id, message: e?.message }));
  }

  res.json({ ok: true, job: upd.rows[0] });
});

async function requireActiveLeaseForJob(req, res, next) {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: 'invalid_job_id' });
  }

  const { rows } = await pool.query(
    'SELECT id, status, printer_id, lease_until, result FROM jobs WHERE id = $1',
    [id]
  );

  if (rows.length === 0) {
    return res.status(404).json({ ok: false, error: 'job_not_found' });
  }

  const job = rows[0];

  if (job.result && job.result.fileRef) {
    return res.json({
      ok: true,
      idempotent: true,
      fileRef: job.result.fileRef || null,
      fileUrl: job.result.fileUrl || null,
    });
  }

  if (job.status !== 'reserved' || job.printer_id !== req.printerId) {
    return res.status(409).json({ ok: false, error: 'job_not_reserved_by_this_printer' });
  }

  if (job.lease_until && new Date(job.lease_until) < new Date()) {
    return res.status(409).json({ ok: false, error: 'lease_expired' });
  }

  req.job = job;
  next();
}

app.post('/api/agent/jobs/:id/scan/upload', requireAgentAuth, requireActiveLeaseForJob, upload.single('file'), async (req, res) => {
  const id = Number(req.params.id);

  // NOTE: multer already ran; ensure rollback on any early return
  const uploadedPath = req.file?.path;
  const cleanupUpload = () => {
    try { if (uploadedPath) fs.unlinkSync(uploadedPath); } catch (_) {}
  };

  if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) {
    cleanupUpload();
    return res.status(400).json({ ok: false, error: 'invalid_job_id' });
  }

  if (!req.file) {
    return res.status(400).json({ ok: false, error: 'file_required' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT id, status, printer_id, lease_until, attempt, result FROM jobs WHERE id = $1',
      [id]
    );
    if (rows.length === 0) {
      cleanupUpload();
      return res.status(404).json({ ok: false, error: 'job_not_found' });
    }

    const job = rows[0];

    if (job.status !== 'reserved' || job.printer_id !== req.printerId) {
      cleanupUpload();
      return res.status(409).json({ ok: false, error: 'job_not_reserved_by_this_printer' });
    }

    if (job.lease_until && new Date(job.lease_until) < new Date()) {
      cleanupUpload();
      logLifecycle({ action: 'upload', jobId: id, printer_id: req.printerId, lease_until: String(job.lease_until), attempt: job.attempt, result_present: false, error: 'lease_expired' });
      return res.status(409).json({ ok: false, error: 'lease_expired' });
    }

    const existingResult = job.result || {};
    if (existingResult.fileUrl || existingResult.fileRef) {
      cleanupUpload();
      logLifecycle({ action: 'upload', jobId: id, printer_id: req.printerId, lease_until: job.lease_until ? String(job.lease_until) : null, attempt: job.attempt, result_present: true, idempotent: true });
      return res.json({
        ok: true,
        idempotent: true,
        fileRef: existingResult.fileRef || null,
        fileUrl: existingResult.fileUrl || null
      });
    }

    const storedName = path.basename(req.file.path);
    const fileUrl = `/api/files/tmp/${storedName}`;

    const newResult = {
      ...(existingResult || {}),
      fileRef: storedName,
      fileUrl,
      origName: req.file.originalname || null,
      size: req.file.size,
      uploadedAt: new Date().toISOString()
    };

    await pool.query(
      'UPDATE jobs SET result=$2::jsonb, updated_at=now() WHERE id=$1',
      [id, JSON.stringify(newResult)]
    );

    logLifecycle({ action: 'upload', jobId: id, printer_id: req.printerId, lease_until: job.lease_until ? String(job.lease_until) : null, attempt: job.attempt, result_present: true });
    res.json({ ok: true, fileRef: storedName, fileUrl });
  } catch (e) {
    cleanupUpload();
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: 'scan/upload DB error', message: e?.message, code: e?.code }));
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

app.post('/api/agent/jobs/:id/fail', requireAgentAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: 'invalid_job_id' });
  }

  const error = req.body?.error ?? { message: 'failed' };

  const { rows } = await pool.query('SELECT * FROM jobs WHERE id = $1', [id]);
  if (rows.length === 0) return res.status(404).json({ ok: false, error: 'job_not_found' });

  const job = rows[0];

  if (job.status === 'failed') {
    logLifecycle({ action: 'fail', jobId: id, printer_id: req.printerId, lease_until: job.lease_until ? String(job.lease_until) : null, attempt: job.attempt, result_present: !!(job.result && (job.result.fileRef || job.result.fileUrl)), idempotent: true });
    return res.json({ ok: true, job, idempotent: true });
  }
  if (job.status === 'completed') return res.status(409).json({ ok: false, error: 'job_already_completed' });

  if (job.status !== 'reserved' || job.printer_id !== req.printerId) {
    return res.status(409).json({ ok: false, error: 'job_not_reserved_by_this_printer' });
  }
  if (job.lease_until && new Date(job.lease_until) < new Date()) {
    logLifecycle({ action: 'fail', jobId: id, printer_id: req.printerId, lease_until: String(job.lease_until), attempt: job.attempt, result_present: !!(job.result && (job.result.fileRef || job.result.fileUrl)), error: 'lease_expired' });
    return res.status(409).json({ ok: false, error: 'lease_expired' });
  }

  const upd = await pool.query(
    `
      UPDATE jobs
         SET status='failed',
             error=$2::jsonb,
             failed_at=now(),
             updated_at=now()
       WHERE id=$1
       RETURNING *;
    `,
    [id, JSON.stringify(error)]
  );

  logLifecycle({ action: 'fail', jobId: id, printer_id: req.printerId, lease_until: job.lease_until ? String(job.lease_until) : null, attempt: job.attempt, result_present: false });
  res.json({ ok: true, job: upd.rows[0] });
});

app.post('/api/admin/jobs/enqueue', requireAdminAuth, async (req, res) => {
  const payload = req.body?.payload ?? { kind: 'print', note: 'test' };
  const ins = await pool.query(
    `INSERT INTO jobs(status, payload) VALUES ('queued', $1::jsonb) RETURNING *`,
    [JSON.stringify(payload)]
  );
  res.json({ ok: true, job: ins.rows[0] });
});

app.get('/api/admin/jobs', requireAdminAuth, async (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
  const { rows } = await pool.query(`SELECT * FROM jobs ORDER BY id DESC LIMIT $1`, [limit]);
  res.json({ ok: true, jobs: rows });
});

// Minimal read-only visibility for scan-class jobs (admin only).
// Supports filtering by status and error.code (e.g. SCAN_TIMEOUT).
app.get('/api/admin/jobs/scan/recent', requireAdminAuth, async (req, res) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit || 20)));
  const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
  const errorCode = typeof req.query.error_code === 'string' ? req.query.error_code.trim() : '';

  const where = [`(payload->>'kind') LIKE 'scan_%'`];
  const args = [limit];
  let i = 2;

  if (status) {
    where.push(`status = $${i++}`);
    args.push(status);
  }
  if (errorCode) {
    where.push(`(error->>'code') = $${i++}`);
    args.push(errorCode);
  }

  const sql = `
    SELECT
      id,
      status,
      (payload->>'kind') AS kind,
      attempt,
      printer_id,
      lease_until,
      created_at,
      updated_at,
      failed_at,
      completed_at,
      (error->>'code') AS error_code
    FROM jobs
    WHERE ${where.join(' AND ')}
    ORDER BY id DESC
    LIMIT $1
  `;

  const { rows } = await pool.query(sql, args);
  res.json({
    ok: true,
    jobs: rows.map((r) => ({
      id: r.id,
      status: r.status,
      kind: r.kind,
      attempt: r.attempt,
      printer_id: r.printer_id,
      lease_until: r.lease_until,
      created_at: r.created_at,
      updated_at: r.updated_at,
      failed_at: r.failed_at,
      completed_at: r.completed_at,
      error_code: r.error_code || null,
    })),
  });
});

app.get('/api/admin/jobs/:id', requireAdminAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id < 1) return res.status(400).json({ ok: false, error: 'invalid_job_id' });
  const { rows } = await pool.query('SELECT * FROM jobs WHERE id = $1', [id]);
  if (rows.length === 0) return res.status(404).json({ ok: false, error: 'job_not_found' });
  res.json({ ok: true, job: rows[0] });
});

// Canonical portal intake: payload.fileUrl is required for Agent download; fileRef is metadata only.
async function handlePortalJobCreate(req, res) {
  const uploadedPath = req.file?.path;
  const cleanup = () => { try { if (uploadedPath) fs.unlinkSync(uploadedPath); } catch (_) {} };
  if (!req.file) return res.status(400).json({ ok: false, error: 'file_required' });
  try {
    const storedName = path.basename(req.file.path);
    const fileUrl = '/api/files/tmp/' + storedName;
    const payload = {
      kind: 'print',
      fileUrl,
      fileName: req.file.originalname || storedName
    };
    if (req.file.originalname) payload.origName = req.file.originalname;
    payload.fileRef = storedName; // metadata only; Agent uses payload.fileUrl for download
    const ins = await pool.query(
      'INSERT INTO jobs(status, payload) VALUES (\'queued\', $1::jsonb) RETURNING *',
      [JSON.stringify(payload)]
    );
    res.json({ ok: true, job: ins.rows[0] });
  } catch (e) {
    cleanup();
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: 'portal/jobs create', message: e?.message }));
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
}

async function handlePortalScanAdfCreate(req, res) {
  try {
    const kind = req.body?.kind;
    if (kind !== 'scan_adf') {
      return res.status(400).json({ ok: false, error: 'invalid_kind' });
    }

    const payload = { kind: 'scan_adf' };
    const scenario = req.body?.scenario;
    if (typeof scenario === 'string' && scenario.trim()) {
      payload.scenario = scenario.trim();
    }
    const ins = await pool.query(
      'INSERT INTO jobs(status, payload) VALUES (\'queued\', $1::jsonb) RETURNING *',
      [JSON.stringify(payload)]
    );
    res.json({ ok: true, job: ins.rows[0] });
  } catch (e) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: 'portal/jobs create scan_adf', message: e?.message }));
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
}

async function handlePortalJsonPrintCreate(req, res) {
  try {
    const kind = req.body?.kind;
    if (kind !== 'print') {
      return res.status(400).json({ ok: false, error: 'invalid_kind' });
    }

    const fileUrl = req.body?.fileUrl;
    if (typeof fileUrl !== 'string' || !fileUrl.trim()) {
      return res.status(400).json({ ok: false, error: 'missing_fileUrl' });
    }

    const rawCopies = req.body?.copies;
    const copiesNum = rawCopies == null ? 1 : Number(rawCopies);
    if (!Number.isFinite(copiesNum) || copiesNum < 1) {
      return res.status(400).json({ ok: false, error: 'invalid_copies' });
    }

    const payload = {
      kind: 'print',
      fileUrl: fileUrl.trim(),
      copies: Math.floor(copiesNum)
    };

    const ins = await pool.query(
      'INSERT INTO jobs(status, payload) VALUES (\'queued\', $1::jsonb) RETURNING id, status',
      [JSON.stringify(payload)]
    );

    // Minimal response shape for JSON-print intake (Portal copy flow).
    res.status(201).json({ id: ins.rows[0].id, status: ins.rows[0].status });
  } catch (e) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: 'portal/jobs create json print', message: e?.message }));
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
}

function getIdempotencyKey(req) {
  const raw = req.header('Idempotency-Key'); // case-insensitive
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v) return null;
  if (v.length > 200) return null;
  return v;
}

function isScanKind(k) {
  return k === 'scan_adf' || k === 'scan_glass';
}

const COPY_SESSION_STATUS = {
  CREATED: 'created',
  SCANNING: 'scanning',
  SCANNED: 'scanned',
  PAYMENT_PENDING: 'payment_pending',
  PAID: 'paid',
  PRINT_ENQUEUED: 'print_enqueued',
  PRINTING: 'printing',
  PRINTED: 'printed',
  EXPIRED: 'expired',
  FAILED: 'failed',
};

const PAYMENT_STATUS = {
  PENDING: 'pending',
  PAID: 'paid',
  FAILED: 'failed',
  EXPIRED: 'expired',
};

const PAYMENT_INTENT_STATUS = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  FAILED: 'failed',
  EXPIRED: 'expired',
};

const P3_ERROR = {
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  INVALID_COPY_SESSION_ID: 'INVALID_COPY_SESSION_ID',
  COPY_SESSION_NOT_FOUND: 'COPY_SESSION_NOT_FOUND',
  SCAN_NOT_COMPLETED: 'SCAN_NOT_COMPLETED',
  SCAN_RESULT_INVALID: 'SCAN_RESULT_INVALID',
  PAYMENT_NOT_ALLOWED: 'PAYMENT_NOT_ALLOWED',
  PAYMENT_ALREADY_CONFIRMED: 'PAYMENT_ALREADY_CONFIRMED',
  ARTIFACT_EXPIRED: 'ARTIFACT_EXPIRED',
  ARTIFACT_MISSING: 'ARTIFACT_MISSING',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  PAYMENT_EXPIRED: 'PAYMENT_EXPIRED',
  PRINT_JOB_ALREADY_CREATED: 'PRINT_JOB_ALREADY_CREATED',

  INVALID_PAYMENT_INTENT_ID: 'INVALID_PAYMENT_INTENT_ID',
  PAYMENT_INTENT_NOT_FOUND: 'PAYMENT_INTENT_NOT_FOUND',
  PAYMENT_BINDING_MISMATCH: 'PAYMENT_BINDING_MISMATCH',
};

function safeInt(value, fallback, { min, max } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  let v = Math.trunc(n);
  if (typeof min === 'number') v = Math.max(min, v);
  if (typeof max === 'number') v = Math.min(max, v);
  return v;
}

function safeIso(value, fallbackIso) {
  if (typeof value !== 'string') return fallbackIso;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return fallbackIso;
  return new Date(t).toISOString();
}

function addMinutesIso(tsIso, minutes) {
  const t = Date.parse(tsIso);
  if (!Number.isFinite(t)) return null;
  const m = Number(minutes);
  if (!Number.isFinite(m)) return null;
  return new Date(t + m * 60_000).toISOString();
}

const P3_PAYMENT_WINDOW_MIN = safeInt(process.env.P3_PAYMENT_WINDOW_MIN, 5, { min: 1, max: 60 });
const P3_OPERATIONAL_SLACK_MIN = safeInt(process.env.P3_OPERATIONAL_SLACK_MIN, 3, { min: 0, max: 60 });

function computeRetentionDeadlineIso(uploadedAtIso) {
  const effective = P3_PAYMENT_WINDOW_MIN + P3_OPERATIONAL_SLACK_MIN;
  return addMinutesIso(uploadedAtIso, effective);
}

function toCopySessionReadModel(row) {
  return {
    id: row.id,
    status: row.status,
    paymentStatus: row.payment_status,
    scanJobId: row.scan_job_id,
    printJobId: row.print_job_id,
    pages: row.pages == null ? null : Number(row.pages),
    price: row.price == null ? null : Number(row.price),
    currency: row.currency || null,
    errorCode: row.error_code || null,
  };
}

async function projectScanJobToCopySession(client, copySessionId) {
  const csQ = await client.query(`SELECT * FROM copy_sessions WHERE id = $1 FOR UPDATE`, [copySessionId]);
  if (csQ.rowCount === 0) return { ok: false, error: P3_ERROR.COPY_SESSION_NOT_FOUND };
  const cs = csQ.rows[0];

  // Idempotent guard: once we are beyond scan projection, do not re-write.
  if ([
    COPY_SESSION_STATUS.PAYMENT_PENDING,
    COPY_SESSION_STATUS.PAID,
    COPY_SESSION_STATUS.PRINT_ENQUEUED,
    COPY_SESSION_STATUS.PRINTED,
    COPY_SESSION_STATUS.EXPIRED,
    COPY_SESSION_STATUS.FAILED,
  ].includes(cs.status)) {
    return { ok: true, noop: true };
  }

  const jobQ = await client.query(`SELECT id, status, result, error FROM jobs WHERE id = $1`, [cs.scan_job_id]);
  if (jobQ.rowCount === 0) {
    await client.query(
      `UPDATE copy_sessions SET status=$2, error_code=$3, updated_at=now() WHERE id=$1`,
      [cs.id, COPY_SESSION_STATUS.FAILED, 'SCAN_FAILED']
    );
    return { ok: true, projected: 'scan_missing' };
  }

  const job = jobQ.rows[0];
  if (job.status === 'failed') {
    await client.query(
      `UPDATE copy_sessions SET status=$2, error_code=$3, updated_at=now() WHERE id=$1`,
      [cs.id, COPY_SESSION_STATUS.FAILED, 'SCAN_FAILED']
    );
    return { ok: true, projected: 'scan_failed' };
  }
  if (job.status !== 'completed') return { ok: false, error: P3_ERROR.SCAN_NOT_COMPLETED };

  const r = job.result || {};
  const fileRef = typeof r.fileRef === 'string' ? r.fileRef.trim() : '';
  const fileUrl = typeof r.fileUrl === 'string' ? r.fileUrl.trim() : '';
  if (!fileRef || !fileUrl) return { ok: false, error: P3_ERROR.SCAN_RESULT_INVALID };

  const uploadedAt = safeIso(r.uploadedAt, new Date().toISOString());
  const retentionDeadlineIso = computeRetentionDeadlineIso(uploadedAt);

  const pages = Number.isFinite(Number(r.pages)) ? Number(r.pages) : null;
  const price = Number.isFinite(Number(r.price)) ? Number(r.price) : null;
  const currency = cs.currency || r.currency || 'KZT';

  await client.query(
    `
      UPDATE copy_sessions
         SET status = $2,
             pages = $3,
             price = $4,
             currency = $5,
             artifact_file_ref = $6,
             artifact_file_url = $7,
             artifact_uploaded_at = $8,
             artifact_retention_deadline = $9,
             updated_at = now()
       WHERE id = $1
    `,
    [cs.id, COPY_SESSION_STATUS.PAYMENT_PENDING, pages, price, currency, fileRef, fileUrl, uploadedAt, retentionDeadlineIso]
  );

  return { ok: true, projected: 'scan_completed' };
}

async function enqueuePrintForCopySession(client, cs) {
  if (cs.print_job_id) return { ok: true, idempotent: true, printJobId: cs.print_job_id };
  if (cs.payment_status !== PAYMENT_STATUS.PAID) return { ok: false, error: P3_ERROR.PAYMENT_NOT_ALLOWED };

  const hasArtifact = !!(cs.artifact_file_ref && cs.artifact_file_url);
  if (!hasArtifact) return { ok: false, error: P3_ERROR.ARTIFACT_MISSING };

  const fileName = `copy-${cs.id}.pdf`;

  const ins = await client.query(
    `INSERT INTO jobs(status, payload) VALUES ('queued', $1::jsonb) RETURNING id`,
    [JSON.stringify({
      kind: 'print',
      fileUrl: cs.artifact_file_url,
      fileName,
      source: { copySessionId: cs.id, scanJobId: cs.scan_job_id },
    })]
  );

  const printJobId = ins.rows[0].id;
  await client.query(
    `UPDATE copy_sessions SET print_job_id=$2, status=$3, updated_at=now() WHERE id=$1`,
    [cs.id, printJobId, COPY_SESSION_STATUS.PRINT_ENQUEUED]
  );
  return { ok: true, printJobId };
}

app.post('/api/portal/jobs', requirePortalAuth, (req, res, next) => {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (ct.includes('multipart/form-data')) {
    return uploadPrint.single('file')(req, res, (err) => {
      if (err) return next(err);
      return handlePortalJobCreate(req, res);
    });
  }
  if (ct.includes('application/json')) {
    const kind = req.body?.kind;
    if (kind === 'scan_adf') return handlePortalScanAdfCreate(req, res);
    if (kind === 'print') return handlePortalJsonPrintCreate(req, res);
    return res.status(400).json({ ok: false, error: 'invalid_kind' });
  }
  return res.status(415).json({ ok: false, error: 'unsupported_content_type' });
});

app.post('/api/portal/copy-sessions', requirePortalAuth, async (req, res) => {
  const scanKind = req.body?.scanKind;
  if (!isScanKind(scanKind)) {
    return res.status(400).json({ ok: false, error: P3_ERROR.INVALID_ARGUMENT });
  }

  const idempotencyKey = getIdempotencyKey(req);
  if (idempotencyKey) {
    const existing = await pool.query(
      `SELECT id, status, scan_job_id, payment_status
         FROM copy_sessions
        WHERE idempotency_key = $1
        LIMIT 1`,
      [idempotencyKey]
    );
    if (existing.rowCount > 0) {
      const r = existing.rows[0];
      return res.json({
        ok: true,
        copySession: { id: r.id, status: r.status, scanJobId: r.scan_job_id, paymentStatus: r.payment_status },
        idempotent: true,
      });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const payload = { kind: scanKind };
    const insJob = await client.query(
      `INSERT INTO jobs(status, payload) VALUES ('queued', $1::jsonb) RETURNING id`,
      [JSON.stringify(payload)]
    );
    const scanJobId = insJob.rows[0].id;

    const copySessionId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    const insSession = await client.query(
      `
        INSERT INTO copy_sessions(
          id, status, scan_job_id, payment_status, currency, idempotency_key
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, status, scan_job_id, payment_status
      `,
      [copySessionId, 'created', scanJobId, 'pending', 'KZT', idempotencyKey]
    );

    await client.query('COMMIT');
    const r = insSession.rows[0];
    return res.status(201).json({
      ok: true,
      copySession: { id: r.id, status: r.status, scanJobId: r.scan_job_id, paymentStatus: r.payment_status },
    });
  } catch (e) {
    await client.query('ROLLBACK');
    // If idempotency_key raced, return the stored session.
    if (idempotencyKey && String(e?.code) === '23505') {
      const existing = await pool.query(
        `SELECT id, status, scan_job_id, payment_status
           FROM copy_sessions
          WHERE idempotency_key = $1
          LIMIT 1`,
        [idempotencyKey]
      );
      if (existing.rowCount > 0) {
        const r = existing.rows[0];
        return res.json({
          ok: true,
          copySession: { id: r.id, status: r.status, scanJobId: r.scan_job_id, paymentStatus: r.payment_status },
          idempotent: true,
        });
      }
    }
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: 'portal/copy-sessions create', message: e?.message, code: e?.code }));
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  } finally {
    client.release();
  }
});

app.get('/api/portal/copy-sessions/:id', requirePortalAuth, async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: P3_ERROR.INVALID_COPY_SESSION_ID });

  const { rows } = await pool.query(
    `
      SELECT
        id,
        status,
        payment_status,
        scan_job_id,
        print_job_id,
        pages,
        price,
        currency,
        error_code
      FROM copy_sessions
      WHERE id = $1
      LIMIT 1
    `,
    [id]
  );
  if (rows.length === 0) return res.status(404).json({ ok: false, error: P3_ERROR.COPY_SESSION_NOT_FOUND });

  return res.json({ ok: true, copySession: toCopySessionReadModel(rows[0]) });
});

app.post('/api/portal/copy-sessions/:id/payment-intents', requirePortalAuth, async (req, res) => {
  const copySessionId = String(req.params.id || '').trim();
  if (!copySessionId) return res.status(400).json({ ok: false, error: P3_ERROR.INVALID_COPY_SESSION_ID });

  const idempotencyKey = getIdempotencyKey(req);

  // Server-side idempotency: return existing pending intent if any.
  const existingPending = await pool.query(
    `
      SELECT id, status, amount, currency
      FROM payment_intents
      WHERE copy_session_id = $1 AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [copySessionId]
  );
  if (existingPending.rowCount > 0) {
    const pi = existingPending.rows[0];
    return res.json({
      ok: true,
      paymentIntent: { id: pi.id, status: pi.status, amount: pi.amount, currency: pi.currency },
      idempotent: true,
    });
  }

  if (idempotencyKey) {
    const existingByKey = await pool.query(
      `SELECT id, status, amount, currency FROM payment_intents WHERE idempotency_key = $1 LIMIT 1`,
      [idempotencyKey]
    );
    if (existingByKey.rowCount > 0) {
      const pi = existingByKey.rows[0];
      return res.json({
        ok: true,
        paymentIntent: { id: pi.id, status: pi.status, amount: pi.amount, currency: pi.currency },
        idempotent: true,
      });
    }
  }

  const { rows: csRows } = await pool.query(
    `SELECT id, status, payment_status, price, currency, artifact_file_ref, artifact_file_url, artifact_retention_deadline
       FROM copy_sessions
      WHERE id = $1
      LIMIT 1`,
    [copySessionId]
  );
  if (csRows.length === 0) return res.status(404).json({ ok: false, error: P3_ERROR.COPY_SESSION_NOT_FOUND });
  const cs = csRows[0];

  if (cs.status === COPY_SESSION_STATUS.FAILED || cs.status === COPY_SESSION_STATUS.EXPIRED || cs.status === COPY_SESSION_STATUS.PRINTED) {
    return res.status(409).json({ ok: false, error: P3_ERROR.PAYMENT_NOT_ALLOWED });
  }
  if (cs.payment_status === PAYMENT_STATUS.PAID) {
    return res.status(409).json({ ok: false, error: P3_ERROR.PAYMENT_ALREADY_CONFIRMED });
  }
  if (cs.price == null || !Number.isFinite(Number(cs.price))) {
    return res.status(409).json({ ok: false, error: P3_ERROR.SCAN_NOT_COMPLETED });
  }

  const hasArtifact = !!(cs.artifact_file_ref && cs.artifact_file_url);
  if (!hasArtifact) {
    return res.status(409).json({ ok: false, error: P3_ERROR.ARTIFACT_MISSING });
  }
  if (cs.artifact_retention_deadline) {
    const deadlineMs = Date.parse(String(cs.artifact_retention_deadline));
    if (Number.isFinite(deadlineMs) && deadlineMs <= Date.now()) {
      return res.status(409).json({ ok: false, error: P3_ERROR.ARTIFACT_EXPIRED });
    }
  }

  const paymentIntentId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  try {
    const ins = await pool.query(
      `
        INSERT INTO payment_intents(
          id, copy_session_id, amount, currency, status, idempotency_key
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, status, amount, currency
      `,
      [paymentIntentId, copySessionId, Number(cs.price), cs.currency || 'KZT', PAYMENT_INTENT_STATUS.PENDING, idempotencyKey]
    );
    const pi = ins.rows[0];
    return res.status(201).json({
      ok: true,
      paymentIntent: { id: pi.id, status: pi.status, amount: pi.amount, currency: pi.currency },
    });
  } catch (e) {
    if (idempotencyKey && String(e?.code) === '23505') {
      const existingByKey = await pool.query(
        `SELECT id, status, amount, currency FROM payment_intents WHERE idempotency_key = $1 LIMIT 1`,
        [idempotencyKey]
      );
      if (existingByKey.rowCount > 0) {
        const pi = existingByKey.rows[0];
        return res.json({
          ok: true,
          paymentIntent: { id: pi.id, status: pi.status, amount: pi.amount, currency: pi.currency },
          idempotent: true,
        });
      }
    }
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: 'portal/payment-intents create', message: e?.message, code: e?.code }));
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// Trusted payment confirmation skeleton (Cloud-only; no provider integration yet).
// Uses admin auth as a placeholder trusted channel.
app.post('/api/internal/copy-sessions/:id/payment/confirm', requireAdminAuth, async (req, res) => {
  const copySessionId = String(req.params.id || '').trim();
  if (!copySessionId) return res.status(400).json({ ok: false, error: P3_ERROR.INVALID_COPY_SESSION_ID });

  const paymentIntentId = typeof req.body?.paymentIntentId === 'string' ? req.body.paymentIntentId.trim() : '';
  if (!paymentIntentId) return res.status(400).json({ ok: false, error: P3_ERROR.INVALID_PAYMENT_INTENT_ID });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const csQ = await client.query(
      `SELECT * FROM copy_sessions WHERE id = $1 FOR UPDATE`,
      [copySessionId]
    );
    if (csQ.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: P3_ERROR.COPY_SESSION_NOT_FOUND });
    }
    const cs = csQ.rows[0];

    const piQ = await client.query(
      `SELECT * FROM payment_intents WHERE id = $1 FOR UPDATE`,
      [paymentIntentId]
    );
    if (piQ.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: P3_ERROR.PAYMENT_INTENT_NOT_FOUND });
    }
    const pi = piQ.rows[0];

    // Strict binding: payment_intent must belong to this copy_session.
    if (String(pi.copy_session_id) !== String(cs.id)) {
      await client.query('ROLLBACK');
      console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', msg: 'payment_binding_mismatch', copySessionId, paymentIntentId, intent_copy_session_id: pi.copy_session_id }));
      return res.status(403).json({ ok: false, error: P3_ERROR.PAYMENT_BINDING_MISMATCH });
    }

    // Replay-safe: if already confirmed for this session, return idempotently.
    if (cs.payment_status === PAYMENT_STATUS.PAID) {
      await client.query('COMMIT');
      return res.json({ ok: true, copySessionId: cs.id, paymentIntentId: pi.id, idempotent: true });
    }

    // Eligibility: do not confirm paid for terminal/forbidden session states.
    if (cs.status === COPY_SESSION_STATUS.EXPIRED || cs.status === COPY_SESSION_STATUS.FAILED || cs.status === COPY_SESSION_STATUS.PRINTED) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, error: P3_ERROR.PAYMENT_NOT_ALLOWED });
    }
    if (cs.payment_status === PAYMENT_STATUS.EXPIRED || cs.payment_status === PAYMENT_STATUS.FAILED) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, error: P3_ERROR.PAYMENT_NOT_ALLOWED });
    }

    // Retention gate: forbid confirming paid if artifact is missing/expired.
    const hasArtifact = !!(cs.artifact_file_ref && cs.artifact_file_url);
    if (!hasArtifact) {
      await client.query(`UPDATE copy_sessions SET error_code=$2, updated_at=now() WHERE id=$1`, [cs.id, 'ARTIFACT_MISSING']);
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, error: P3_ERROR.ARTIFACT_MISSING });
    }
    if (cs.artifact_retention_deadline) {
      const deadlineMs = Date.parse(String(cs.artifact_retention_deadline));
      if (Number.isFinite(deadlineMs) && deadlineMs <= Date.now()) {
        await client.query(`UPDATE copy_sessions SET error_code=$2, updated_at=now() WHERE id=$1`, [cs.id, 'ARTIFACT_EXPIRED']);
        await client.query('ROLLBACK');
        return res.status(409).json({ ok: false, error: P3_ERROR.ARTIFACT_EXPIRED });
      }
    }

    // Intent idempotency: if already confirmed, ok.
    if (pi.status === PAYMENT_INTENT_STATUS.CONFIRMED) {
      await client.query('COMMIT');
      return res.json({ ok: true, copySessionId: cs.id, paymentIntentId: pi.id, idempotent: true });
    }

    await client.query(
      `
        UPDATE payment_intents
           SET status = $2,
               confirmed_at = now(),
               updated_at = now()
         WHERE id = $1
      `,
      [pi.id, PAYMENT_INTENT_STATUS.CONFIRMED]
    );
    await client.query(
      `
        UPDATE copy_sessions
           SET payment_status = $3,
               status = $4,
               payment_intent_id = $2,
               payment_confirmed_at = now(),
               updated_at = now()
         WHERE id = $1
      `,
      [cs.id, pi.id, PAYMENT_STATUS.PAID, COPY_SESSION_STATUS.PAID]
    );

    // Enqueue print-after-paid (atomic/idempotent).
    const cs2 = (await client.query(`SELECT * FROM copy_sessions WHERE id = $1 FOR UPDATE`, [cs.id])).rows[0];
    const enq = await enqueuePrintForCopySession(client, cs2);
    if (!enq.ok) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, error: enq.error });
    }

    await client.query('COMMIT');
    console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'payment_confirmed', copySessionId: cs.id, paymentIntentId: pi.id }));
    console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'print_enqueued_for_copy_session', copySessionId: cs.id, printJobId: enq.printJobId || null }));
    return res.json({ ok: true, copySessionId: cs.id, paymentIntentId: pi.id, printJobId: enq.printJobId || null });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: 'internal/payment confirm', message: e?.message, code: e?.code }));
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  } finally {
    client.release();
  }
});

// Legacy only: do not evolve. Keeps payload.fileUrl + fileName for existing Agent compatibility.
app.post('/api/portal/upload-print', requireAdminAuth, uploadPrint.single('file'), async (req, res) => {
  const uploadedPath = req.file?.path;
  const cleanup = () => { try { if (uploadedPath) fs.unlinkSync(uploadedPath); } catch (_) {} };
  if (!req.file) return res.status(400).json({ ok: false, error: 'file_required' });
  try {
    const storedName = path.basename(req.file.path);
    const fileUrl = '/api/files/tmp/' + storedName;
    const payload = { kind: 'print', fileUrl, fileName: req.file.originalname || storedName };
    if (req.file.originalname) payload.origName = req.file.originalname;
    const ins = await pool.query(
      'INSERT INTO jobs(status, payload) VALUES (\'queued\', $1::jsonb) RETURNING *',
      [JSON.stringify(payload)]
    );
    res.json({ ok: true, job: ins.rows[0] });
  } catch (e) {
    cleanup();
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: 'portal/upload-print', message: e?.message }));
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

// Read-only; no payload, printer_id, or internal failure metadata.
app.get('/api/portal/jobs/:id', requirePortalAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || !Number.isInteger(id) || id < 1) {
    return res.status(400).json({ ok: false, error: 'invalid_job_id' });
  }
  const { rows } = await pool.query(
    'SELECT id, status, created_at, updated_at, payload, result FROM jobs WHERE id = $1',
    [id]
  );
  if (rows.length === 0) return res.status(404).json({ ok: false, error: 'job_not_found' });
  const row = rows[0];
  const payload = row.payload || {};
  const result = row.result || {};

  res.json({
    ok: true,
    job: {
      id: row.id,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
      payload: {
        kind: typeof payload.kind === 'string' ? payload.kind : null,
      },
      result: {
        fileUrl: typeof result.fileUrl === 'string' ? result.fileUrl : null,
        pages: Number.isFinite(Number(result.pages)) ? Number(result.pages) : null,
      },
    }
  });
});

initDb()
  .then(() => {
    app.use('/api/files', filesRouter);
    // Docker compose: ./portal is mounted at /app/portal (working_dir=/app, __dirname=/app).
    // Local repo: portal is sibling of api/ (../portal).
    const portalDir = fs.existsSync(path.join(__dirname, 'portal'))
      ? path.join(__dirname, 'portal')
      : path.join(__dirname, '..', 'portal');
    app.use('/portal', express.static(portalDir));
    app.use(errorMiddleware);
    app.listen(port, () => console.log(`Cloud API listening on ${port} @ ${nowIso()}`));
  })
  .catch((e) => {
    console.error('DB init failed:', e);
    process.exit(1);
  });
