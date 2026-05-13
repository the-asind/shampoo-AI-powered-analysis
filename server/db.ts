import Database from "better-sqlite3";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import type { Audience, IngredientAnalysis, Shampoo } from "./types.js";
import { mockShampoos } from "./mock-data.js";

dotenv.config();

const databasePath = process.env.DATABASE_PATH ?? "./data/shampoo.sqlite";
fs.mkdirSync(path.dirname(databasePath), { recursive: true });

export const db = new Database(databasePath);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS shampoos (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    brand_note TEXT NOT NULL DEFAULT '',
    score INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
    price INTEGER NOT NULL DEFAULT 0,
    fit_json TEXT NOT NULL,
    base TEXT NOT NULL DEFAULT '',
    verdict TEXT NOT NULL DEFAULT '',
    signals_json TEXT NOT NULL DEFAULT '[]',
    caution TEXT NOT NULL DEFAULT '',
    inci TEXT NOT NULL DEFAULT '',
    composition TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'published',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_shampoos_status_score
    ON shampoos(status, score DESC, id DESC);

  CREATE TABLE IF NOT EXISTS analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    input_hash TEXT NOT NULL,
    composition TEXT NOT NULL,
    result_json TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_analyses_input_hash_created
    ON analyses(input_hash, created_at DESC);

  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL DEFAULT '',
    composition TEXT NOT NULL,
    analysis_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_submissions_status_created
    ON submissions(status, created_at DESC);

  CREATE TABLE IF NOT EXISTS rate_limits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_ip TEXT NOT NULL,
    action TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(client_ip, action, window_start)
  );

  CREATE INDEX IF NOT EXISTS idx_rate_limits_lookup
    ON rate_limits(client_ip, action, window_start);
`);

const shampooColumns = db.prepare("PRAGMA table_info(shampoos)").all() as Array<{ name: string }>;
if (!shampooColumns.some((column) => column.name === "inci")) {
  db.prepare("ALTER TABLE shampoos ADD COLUMN inci TEXT NOT NULL DEFAULT ''").run();
}

const replaceShampoos = db.transaction((items: Shampoo[]) => {
  db.prepare("DELETE FROM shampoos").run();

  const insert = db.prepare(`
    INSERT INTO shampoos (
      id, name, brand_note, score, price, fit_json, base, verdict,
      signals_json, caution, inci, status
    ) VALUES (
      @id, @name, @brandNote, @score, @price, @fitJson, @base, @verdict,
      @signalsJson, @caution, @inci, 'published'
    )
  `);

  for (const item of items) {
    insert.run({
      ...item,
      fitJson: JSON.stringify(item.fit),
      signalsJson: JSON.stringify(item.signals),
    });
  }
});

replaceShampoos(mockShampoos);

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mapShampoo(row: Record<string, unknown>): Shampoo {
  return {
    id: Number(row.id),
    name: String(row.name),
    brandNote: String(row.brand_note),
    score: Number(row.score),
    price: Number(row.price),
    fit: parseJsonArray(String(row.fit_json)) as Audience[],
    base: String(row.base),
    verdict: String(row.verdict),
    signals: parseJsonArray(String(row.signals_json)),
    caution: String(row.caution),
    inci: String(row.inci),
  };
}

export function listShampoos(audience?: Audience) {
  const rows = db
    .prepare("SELECT * FROM shampoos WHERE status = 'published' ORDER BY score DESC, id DESC")
    .all() as Record<string, unknown>[];
  const items = rows.map(mapShampoo);
  return audience ? items.filter((item) => item.fit.includes(audience)) : items;
}

export function listTopShampoos(limit = 3) {
  const rows = db
    .prepare("SELECT * FROM shampoos WHERE status = 'published' ORDER BY score DESC, id DESC LIMIT ?")
    .all(limit) as Record<string, unknown>[];
  return rows.map(mapShampoo);
}

export type ShampooComparisonReference = {
  label: string;
  item: Shampoo;
};

function topByAudience(items: Shampoo[], audience: Audience, usedIds: Set<number>) {
  return items.find((item) => item.fit.includes(audience) && !usedIds.has(item.id));
}

function closestToScore(items: Shampoo[], targetScore: number, usedIds: Set<number>) {
  return items
    .filter((item) => !usedIds.has(item.id))
    .sort((a, b) => {
      const distance = Math.abs(a.score - targetScore) - Math.abs(b.score - targetScore);
      return distance || b.score - a.score || b.id - a.id;
    })[0];
}

export function listComparisonShampoos() {
  const rows = db
    .prepare("SELECT * FROM shampoos WHERE status = 'published' ORDER BY score DESC, id DESC")
    .all() as Record<string, unknown>[];
  const items = rows.map(mapShampoo);
  const usedIds = new Set<number>();
  const references: ShampooComparisonReference[] = [];

  const add = (label: string, item: Shampoo | undefined) => {
    if (!item || usedIds.has(item.id)) {
      return;
    }

    usedIds.add(item.id);
    references.push({ label, item });
  };

  add("лидер для нормальной кожи головы", topByAudience(items, "normal", usedIds));
  add("лидер для жирной кожи головы", topByAudience(items, "oily", usedIds));
  add("лидер для чувствительной кожи головы", topByAudience(items, "sensitive", usedIds));
  add("ориентир около 70 баллов", closestToScore(items, 70, usedIds));
  add("ориентир около 60 баллов", closestToScore(items, 60, usedIds));
  add("ориентир около 50 баллов", closestToScore(items, 50, usedIds));

  return references;
}

export function saveAnalysis(params: {
  inputHash: string;
  composition: string;
  result: IngredientAnalysis;
  provider: string;
  model: string;
  promptVersion: string;
}) {
  db.prepare(`
    INSERT INTO analyses (input_hash, composition, result_json, provider, model, prompt_version)
    VALUES (@inputHash, @composition, @resultJson, @provider, @model, @promptVersion)
  `).run({
    inputHash: params.inputHash,
    composition: params.composition,
    resultJson: JSON.stringify(params.result),
    provider: params.provider,
    model: params.model,
    promptVersion: params.promptVersion,
  });
}

export function createSubmission(params: {
  name: string;
  price: string;
  sourceUrl: string;
  composition: string;
  analysis: IngredientAnalysis;
}) {
  const result = db
    .prepare(`
      INSERT INTO submissions (name, price, source_url, composition, analysis_json)
      VALUES (@name, @price, @sourceUrl, @composition, @analysisJson)
    `)
    .run({
      name: params.name,
      price: params.price,
      sourceUrl: params.sourceUrl,
      composition: params.composition,
      analysisJson: JSON.stringify(params.analysis),
    });

  return { id: Number(result.lastInsertRowid), status: "pending" };
}

export function checkRateLimit(params: {
  clientIp: string;
  action: "analyze" | "submit_shampoo";
  now?: number;
}) {
  const now = params.now ?? Date.now();
  const minuteMs = 60_000;
  const dayMs = 24 * 60 * 60 * 1000;
  const perMinute = Number(process.env.RATE_LIMIT_PER_MINUTE ?? 1);
  const perDay = Number(process.env.RATE_LIMIT_PER_DAY ?? 10);
  const minuteWindow = Math.floor(now / minuteMs) * minuteMs;
  const dayWindow = Math.floor(now / dayMs) * dayMs;

  db.prepare("DELETE FROM rate_limits WHERE window_start < ?").run(dayWindow - dayMs);

  const apply = db.transaction(() => {
    const minuteRow = db
      .prepare("SELECT count FROM rate_limits WHERE client_ip = ? AND action = ? AND window_start = ?")
      .get(params.clientIp, `${params.action}:minute`, minuteWindow) as { count: number } | undefined;
    if ((minuteRow?.count ?? 0) >= perMinute) {
      return {
        allowed: false,
        reason: "minute_quota_exceeded",
        retryAfterSeconds: Math.max(1, Math.ceil((minuteWindow + minuteMs - now) / 1000)),
      };
    }

    const dayRow = db
      .prepare("SELECT count FROM rate_limits WHERE client_ip = ? AND action = ? AND window_start = ?")
      .get(params.clientIp, `${params.action}:day`, dayWindow) as { count: number } | undefined;
    if ((dayRow?.count ?? 0) >= perDay) {
      return {
        allowed: false,
        reason: "daily_quota_exceeded",
        retryAfterSeconds: Math.max(1, Math.ceil((dayWindow + dayMs - now) / 1000)),
      };
    }

    db.prepare(`
      INSERT INTO rate_limits (client_ip, action, window_start, count)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(client_ip, action, window_start)
      DO UPDATE SET count = count + 1, updated_at = CURRENT_TIMESTAMP
    `).run(params.clientIp, `${params.action}:minute`, minuteWindow);

    db.prepare(`
      INSERT INTO rate_limits (client_ip, action, window_start, count)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(client_ip, action, window_start)
      DO UPDATE SET count = count + 1, updated_at = CURRENT_TIMESTAMP
    `).run(params.clientIp, `${params.action}:day`, dayWindow);

    return { allowed: true, remainingDaily: Math.max(0, perDay - 1 - (dayRow?.count ?? 0)) };
  });

  return apply();
}
