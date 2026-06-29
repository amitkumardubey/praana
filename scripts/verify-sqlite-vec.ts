#!/usr/bin/env bun
/**
 * Smoke test: bun:sqlite + sqlite-vec (same stack as the Bun migration).
 * Run on macOS before/after migration: bun run verify:sqlite-vec
 */
import * as sqliteVec from "sqlite-vec";
import { arch, platform } from "node:process";
import { initBunSqlite, openDatabase } from "../src/sqlite.js";

const DIM = 384;

initBunSqlite();
const db = openDatabase(":memory:");

sqliteVec.load(db);
const version = db.prepare("SELECT vec_version() AS v").get() as { v: string };
console.log(`platform: ${platform}-${arch}`);
console.log(`vec_version: ${version.v}`);

db.exec(`
  CREATE VIRTUAL TABLE entries_vec USING vec0(
    entry_id TEXT PRIMARY KEY,
    embedding float[${DIM}]
  )
`);

const a = new Float32Array(DIM);
const b = new Float32Array(DIM);
a.fill(1);
b.fill(0);
b[0] = 1;

db.prepare("INSERT INTO entries_vec (entry_id, embedding) VALUES (?, ?)").run(
  "near",
  a,
);
db.prepare("INSERT INTO entries_vec (entry_id, embedding) VALUES (?, ?)").run(
  "far",
  b,
);

const knn = db
  .prepare(
    `SELECT entry_id, distance FROM entries_vec
     WHERE embedding MATCH ? AND k = ?
     ORDER BY distance`,
  )
  .all(a, 2) as Array<{ entry_id: string; distance: number }>;

if (knn.length !== 2 || knn[0]?.entry_id !== "near") {
  console.error("k-NN failed:", knn);
  process.exit(1);
}

console.log("k-NN top hit:", knn[0].entry_id, "distance:", knn[0].distance);
db.close();
console.log("OK — bun:sqlite + sqlite-vec verified");
