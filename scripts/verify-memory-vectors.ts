#!/usr/bin/env bun
/**
 * Smoke test: bun:sqlite BLOB embeddings + cosine kNN (no sqlite-vec).
 * Run: bun run verify:memory-vectors
 */
import { arch, platform } from "node:process";
import { openMemoryDb, searchByVector, upsertEmbedding } from "../src/memory/db.js";

const DIM = 4;

const { db } = openMemoryDb(":memory:", DIM);
console.log(`platform: ${platform}-${arch}`);

const near = new Float32Array(DIM);
near.fill(1);
const far = new Float32Array(DIM);
far[0] = 1;

upsertEmbedding(db, "near", near);
upsertEmbedding(db, "far", far);

const knn = searchByVector(db, near, 2);
if (knn.length !== 2 || knn[0]?.entry_id !== "near") {
  console.error("k-NN failed:", knn);
  process.exit(1);
}

console.log("k-NN top hit:", knn[0].entry_id, "distance:", knn[0].distance);
db.close();
console.log("OK — bun:sqlite BLOB cosine kNN verified");
