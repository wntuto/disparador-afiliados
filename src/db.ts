import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Platform = 'shopee' | 'mercadolivre';
export type CampaignMode = 'manual' | 'once' | 'recurring';

export interface Group {
  id: number;
  name: string;
  recipient: string; // formato Zapster: "group:<id>"
  active: number;
  created_at: string;
}

export interface Offer {
  id: number;
  platform: Platform;
  external_id: string | null;
  title: string;
  price: number | null;
  original_price: number | null;
  discount_pct: number | null;
  commission_rate: number | null;
  image_url: string | null;
  product_url: string;
  affiliate_link: string;
  created_at: string;
}

export interface Campaign {
  id: number;
  name: string;
  template: string | null;
  group_ids: number[];
  offer_ids: number[];
  mode: CampaignMode;
  run_at: string | null; // ISO, para mode = once
  cron: string | null; // expressão cron, para mode = recurring
  send_image: number;
  next_offer_index: number;
  active: number;
  last_run_at: string | null;
  created_at: string;
}

export interface Send {
  id: number;
  campaign_id: number | null;
  offer_id: number;
  group_id: number;
  status: 'sent' | 'failed';
  message_id: string | null;
  error: string | null;
  created_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  recipient TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL CHECK (platform IN ('shopee','mercadolivre')),
  external_id TEXT,
  title TEXT NOT NULL,
  price REAL,
  original_price REAL,
  discount_pct REAL,
  commission_rate REAL,
  image_url TEXT,
  product_url TEXT NOT NULL,
  affiliate_link TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  template TEXT,
  group_ids TEXT NOT NULL DEFAULT '[]',
  offer_ids TEXT NOT NULL DEFAULT '[]',
  mode TEXT NOT NULL CHECK (mode IN ('manual','once','recurring')),
  run_at TEXT,
  cron TEXT,
  send_image INTEGER NOT NULL DEFAULT 1,
  next_offer_index INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  offer_id INTEGER NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  message_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sends_created ON sends(created_at DESC);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

type Row = Record<string, unknown>;

function toCampaign(row: Row): Campaign {
  return {
    ...(row as unknown as Campaign),
    group_ids: JSON.parse(String(row.group_ids)),
    offer_ids: JSON.parse(String(row.offer_ids)),
  };
}

export function openDb(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return createRepo(db);
}

function createRepo(db: DatabaseSync) {
  const all = <T>(sql: string, ...params: any[]) => db.prepare(sql).all(...params) as T[];
  const get = <T>(sql: string, ...params: any[]) => db.prepare(sql).get(...params) as T | undefined;
  const run = (sql: string, ...params: any[]) => db.prepare(sql).run(...params);

  return {
    raw: db,

    // Grupos
    listGroups: () => all<Group>('SELECT * FROM groups ORDER BY name'),
    getGroup: (id: number) => get<Group>('SELECT * FROM groups WHERE id = ?', id),
    upsertGroup(name: string, recipient: string): Group {
      run(
        `INSERT INTO groups (name, recipient) VALUES (?, ?)
         ON CONFLICT(recipient) DO UPDATE SET name = excluded.name`,
        name,
        recipient,
      );
      return get<Group>('SELECT * FROM groups WHERE recipient = ?', recipient)!;
    },
    setGroupActive: (id: number, active: boolean) =>
      run('UPDATE groups SET active = ? WHERE id = ?', active ? 1 : 0, id),
    deleteGroup: (id: number) => run('DELETE FROM groups WHERE id = ?', id),

    // Ofertas
    listOffers: () => all<Offer>('SELECT * FROM offers ORDER BY id DESC'),
    getOffer: (id: number) => get<Offer>('SELECT * FROM offers WHERE id = ?', id),
    createOffer(o: Omit<Offer, 'id' | 'created_at'>): Offer {
      const r = run(
        `INSERT INTO offers (platform, external_id, title, price, original_price, discount_pct,
           commission_rate, image_url, product_url, affiliate_link)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        o.platform,
        o.external_id,
        o.title,
        o.price,
        o.original_price,
        o.discount_pct,
        o.commission_rate,
        o.image_url,
        o.product_url,
        o.affiliate_link,
      );
      return get<Offer>('SELECT * FROM offers WHERE id = ?', Number(r.lastInsertRowid))!;
    },
    deleteOffer: (id: number) => run('DELETE FROM offers WHERE id = ?', id),

    // Campanhas (manuais ou agendadas)
    listCampaigns: () => all<Row>('SELECT * FROM campaigns ORDER BY id DESC').map(toCampaign),
    getCampaign(id: number) {
      const row = get<Row>('SELECT * FROM campaigns WHERE id = ?', id);
      return row ? toCampaign(row) : undefined;
    },
    createCampaign(
      c: Pick<Campaign, 'name' | 'template' | 'group_ids' | 'offer_ids' | 'mode' | 'run_at' | 'cron' | 'send_image'>,
    ): Campaign {
      const r = run(
        `INSERT INTO campaigns (name, template, group_ids, offer_ids, mode, run_at, cron, send_image)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        c.name,
        c.template,
        JSON.stringify(c.group_ids),
        JSON.stringify(c.offer_ids),
        c.mode,
        c.run_at,
        c.cron,
        c.send_image,
      );
      return this.getCampaign(Number(r.lastInsertRowid))!;
    },
    setCampaignActive: (id: number, active: boolean) =>
      run('UPDATE campaigns SET active = ? WHERE id = ?', active ? 1 : 0, id),
    markCampaignRun: (id: number, nextOfferIndex: number, deactivate: boolean) =>
      run(
        `UPDATE campaigns SET last_run_at = datetime('now'), next_offer_index = ?,
           active = CASE WHEN ? THEN 0 ELSE active END WHERE id = ?`,
        nextOfferIndex,
        deactivate ? 1 : 0,
        id,
      ),
    deleteCampaign: (id: number) => run('DELETE FROM campaigns WHERE id = ?', id),
    /** Campanhas "once" ativas cujo horário já passou. */
    dueOnceCampaigns: (nowIso: string) =>
      all<Row>(
        `SELECT * FROM campaigns WHERE mode = 'once' AND active = 1 AND run_at IS NOT NULL AND run_at <= ?`,
        nowIso,
      ).map(toCampaign),
    activeRecurringCampaigns: () =>
      all<Row>(`SELECT * FROM campaigns WHERE mode = 'recurring' AND active = 1`).map(toCampaign),

    // Configurações salvas pelo painel
    getSettings: () =>
      Object.fromEntries(all<{ key: string; value: string }>('SELECT key, value FROM settings').map((r) => [r.key, r.value])),
    setSetting: (key: string, value: string) =>
      run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value),

    // Histórico de envios
    logSend(s: Omit<Send, 'id' | 'created_at'>) {
      run(
        `INSERT INTO sends (campaign_id, offer_id, group_id, status, message_id, error)
         VALUES (?, ?, ?, ?, ?, ?)`,
        s.campaign_id,
        s.offer_id,
        s.group_id,
        s.status,
        s.message_id,
        s.error,
      );
    },
    listSends: (limit = 100) =>
      all<Row>(
        `SELECT s.*, g.name AS group_name, o.title AS offer_title, o.platform
         FROM sends s JOIN groups g ON g.id = s.group_id JOIN offers o ON o.id = s.offer_id
         ORDER BY s.id DESC LIMIT ?`,
        limit,
      ),
  };
}

export type Repo = ReturnType<typeof openDb>;
