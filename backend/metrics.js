// Small time-series store for CPU / RAM history (SQLite via the built-in node:sqlite module).
// One row per sample interval; rows older than the retention window are pruned periodically.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const MAX_POINTS = 2000;

export class MetricsStore {
    constructor(file, retentionMs) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        this.retentionMs = retentionMs;
        this.db = new DatabaseSync(file);
        this.db.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            CREATE TABLE IF NOT EXISTS samples (
                ts        INTEGER PRIMARY KEY,  -- epoch ms
                cpu       REAL    NOT NULL,     -- percent (average over the interval)
                cpu_max   REAL    NOT NULL,     -- percent (peak within the interval)
                mem       INTEGER NOT NULL,     -- bytes
                mem_limit INTEGER NOT NULL      -- bytes
            );
        `);
        this.insertStmt = this.db.prepare('INSERT OR REPLACE INTO samples (ts, cpu, cpu_max, mem, mem_limit) VALUES (?, ?, ?, ?, ?)');
        this.pruneStmt = this.db.prepare('DELETE FROM samples WHERE ts < ?');
        this.rangeStmt = this.db.prepare('SELECT MIN(ts) AS min, MAX(ts) AS max, COUNT(*) AS count FROM samples');
        // JS numbers are bound as REAL, so cast the bucket size to get integer division (= real bucketing).
        this.queryStmt = this.db.prepare(`
            SELECT (ts / CAST(:bucket AS INTEGER)) * CAST(:bucket AS INTEGER) AS t,
                   AVG(cpu) AS cpu, MAX(cpu_max) AS cpuMax,
                   AVG(mem) AS mem, MAX(mem_limit) AS memLimit
            FROM samples
            WHERE ts BETWEEN :from AND :to
            GROUP BY ts / CAST(:bucket AS INTEGER)
            ORDER BY t
        `);
    }

    insert({ ts, cpu, cpuMax, mem, memLimit }) {
        this.insertStmt.run(Math.trunc(ts), cpu, cpuMax, Math.trunc(mem), Math.trunc(memLimit));
    }

    prune(now = Date.now()) {
        return this.pruneStmt.run(now - this.retentionMs).changes;
    }

    range() {
        const { min, max, count } = this.rangeStmt.get();
        return { min, max, count };
    }

    // Downsampled points for [from, to]: at most `points` buckets (average + peak per bucket).
    query(from, to, points) {
        const n = Math.min(Math.max(Math.trunc(points) || 600, 10), MAX_POINTS);
        const bucket = Math.max(1000, Math.ceil((to - from) / n));
        return this.queryStmt.all({ bucket, from: Math.trunc(from), to: Math.trunc(to) }).map((r) => ({
            t: r.t,
            cpu: Math.round(r.cpu * 100) / 100,
            cpuMax: Math.round(r.cpuMax * 100) / 100,
            mem: Math.round(r.mem),
            memLimit: r.memLimit,
        }));
    }

    close() {
        this.db.close();
    }
}
