/**
 * Neon PostgreSQL client — content_analyzer schema.
 *
 * Uses @neondatabase/serverless (HTTP-based, works on Vercel Edge/Node).
 * Falls back to pg (node-postgres) when the serverless driver is unavailable.
 *
 * Phase 2/3: API routes read from Neon instead of local JSON files.
 */

import { type QueryResultRow } from "pg";

// ── Lazy singleton ──────────────────────────────────────────────────────────

type SqlFn = (strings: TemplateStringsArray, ...values: SqlValue[]) => Promise<unknown[]>;

let _sql: SqlFn | null = null;
let _initPromise: Promise<SqlFn> | null = null;

type SqlValue = string | number | boolean | null | string[] | object;

async function initSql(): Promise<SqlFn> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  // Try @neondatabase/serverless first (works on Vercel Edge + Node)
  try {
    const { neon } = await import("@neondatabase/serverless");
    const client = neon(url);
    return async (strings, ...values) => {
      // neon() accepts tagged template literals directly
      return client(strings as unknown as TemplateStringsArray, ...values) as Promise<unknown[]>;
    };
  } catch {
    // Fall back to pg (Node.js only, not Edge)
    const { Client } = await import("pg");
    const client = new Client({ connectionString: url });
    await client.connect();
    return async (strings, ...values) => {
      let text = "";
      const params: unknown[] = [];
      (strings as readonly string[]).forEach((s, i) => {
        text += s;
        if (i < values.length) {
          params.push(values[i]);
          text += `$${params.length}`;
        }
      });
      const res = await client.query(text, params);
      return res.rows;
    };
  }
}

async function getSql(): Promise<SqlFn> {
  if (_sql) return _sql;
  if (_initPromise) return _initPromise;
  _initPromise = initSql().then((fn) => {
    _sql = fn;
    return fn;
  });
  return _initPromise;
}

// ── Public tagged-template helpers ──────────────────────────────────────────

export async function sql<T extends QueryResultRow = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: SqlValue[]
): Promise<T[]> {
  const fn = await getSql();
  return fn(strings, ...values) as Promise<T[]>;
}

export async function sqlOne<T extends QueryResultRow = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: SqlValue[]
): Promise<T | null> {
  const rows = await sql<T>(strings, ...values);
  return rows[0] ?? null;
}

export async function sqlScalar<T = unknown>(
  strings: TemplateStringsArray,
  ...values: SqlValue[]
): Promise<T | null> {
  const rows = await sql(strings, ...values);
  if (!rows[0]) return null;
  const firstKey = Object.keys(rows[0])[0];
  return (rows[0] as Record<string, unknown>)[firstKey] as T;
}

export function isNeonConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}
