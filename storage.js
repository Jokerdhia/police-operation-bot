const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const databaseUrl = process.env.DATABASE_URL?.trim();
let pool = null;
let writeQueue = Promise.resolve();

function usingDatabase() {
  return Boolean(databaseUrl);
}

async function initializeStorage() {
  if (!usingDatabase()) {
    console.warn("⚠️ DATABASE_URL absent : stockage JSON local utilisé (développement uniquement).");
    return;
  }

  pool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("localhost") ? false : { rejectUnauthorized: false },
    max: 5,
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_state (
      state_key TEXT PRIMARY KEY,
      state_value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  console.log("✅ Connexion Neon PostgreSQL établie.");
}

async function loadState(key, fallback, localFile) {
  if (pool) {
    const result = await pool.query(
      "SELECT state_value FROM bot_state WHERE state_key = $1",
      [key]
    );
    return result.rows[0]?.state_value ?? fallback;
  }

  try {
    fs.mkdirSync(path.dirname(localFile), { recursive: true });
    if (!fs.existsSync(localFile)) {
      fs.writeFileSync(localFile, JSON.stringify(fallback, null, 2), "utf8");
      return fallback;
    }
    const raw = fs.readFileSync(localFile, "utf8").trim();
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    console.error(`❌ Impossible de charger ${localFile} :`, error.message);
    return fallback;
  }
}

function saveState(key, value, localFile) {
  const snapshot = JSON.parse(JSON.stringify(value));

  writeQueue = writeQueue
    .then(async () => {
      if (pool) {
        await pool.query(
          `INSERT INTO bot_state (state_key, state_value, updated_at)
           VALUES ($1, $2::jsonb, NOW())
           ON CONFLICT (state_key)
           DO UPDATE SET state_value = EXCLUDED.state_value, updated_at = NOW()`,
          [key, JSON.stringify(snapshot)]
        );
        return;
      }

      fs.mkdirSync(path.dirname(localFile), { recursive: true });
      const tempFile = `${localFile}.tmp`;
      fs.writeFileSync(tempFile, JSON.stringify(snapshot, null, 2), "utf8");
      fs.renameSync(tempFile, localFile);
    })
    .catch((error) => {
      console.error(`❌ Sauvegarde impossible pour ${key} :`, error);
    });

  return writeQueue;
}

async function closeStorage() {
  await writeQueue;
  if (pool) await pool.end();
}

module.exports = {
  initializeStorage,
  loadState,
  saveState,
  closeStorage,
  usingDatabase,
};
