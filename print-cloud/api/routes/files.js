const express = require('express');
const path = require('path');
const fs = require('fs');

const router = express.Router();

// ВАЖНО: путь относительно cwd процесса
const TMP_DIR = path.resolve('storage/tmp');

// ---- DEBUG / health ----
router.get('/ping', (req, res) => {
  res.json({ ok: true });
});

// ---- GET temp file ----
// Авторизацию подключим позже, СЕЙЧАС без неё для отладки
router.get('/tmp/:fileId', (req, res) => {
  const { fileId } = req.params;

  // защита от ../
  if (!/^[a-zA-Z0-9._-]+$/.test(fileId)) {
    return res.status(400).json({ ok: false, error: 'invalid_file_id' });
  }

  const filePath = path.join(TMP_DIR, fileId);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ ok: false, error: 'file_not_found' });
  }

  res.sendFile(filePath);
});

module.exports = router;
