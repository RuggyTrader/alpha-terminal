// Persistent PAPER records with restart recovery: an append-only JSONL audit journal plus an atomically replaced snapshot.
// A tick journals its events, then commits the snapshot (write temp + rename). If the process dies mid-tick, the snapshot is
// still the previous committed state; the journal entries after it are marked ROLLED_BACK on the next start and the same
// hours are re-processed deterministically (the PRNG state is part of the snapshot), so nothing is applied twice.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

export class Store {
  constructor(dir) {
    this.dir = dir; mkdirSync(dir, { recursive: true });
    this.snapPath = join(dir, "state.json"); this.journalPath = join(dir, "journal.jsonl");
    this.state = existsSync(this.snapPath) ? JSON.parse(readFileSync(this.snapPath, "utf8")) : null;
    const committed = this.state?.seq ?? 0;
    let maxSeq = committed, orphans = 0;
    if (existsSync(this.journalPath)) for (const line of readFileSync(this.journalPath, "utf8").split("\n")) {
      if (!line.trim()) continue; let e; try { e = JSON.parse(line); } catch { orphans++; continue; } // torn last line
      maxSeq = Math.max(maxSeq, e.seq); if (e.seq > committed) orphans++;
    }
    this.seq = maxSeq; this.recoveredOrphans = orphans;
    if (orphans) this.journal("ROLLED_BACK", { afterCommittedSeq: committed, entries: orphans, note: "uncommitted tick discarded; its hours will be re-processed" });
  }
  journal(type, data) { const e = { seq: ++this.seq, at: new Date().toISOString(), type, data }; appendFileSync(this.journalPath, JSON.stringify(e) + "\n"); return e; }
  commit(state) { state.seq = this.seq; const tmp = this.snapPath + ".tmp"; writeFileSync(tmp, JSON.stringify(state)); renameSync(tmp, this.snapPath); this.state = state; }
}
