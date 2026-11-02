// channel.db: the mock channel's OWN ledger, deliberately separate from engine.db.
// A send commits here in its own txn; the engine acks in another txn. The window
// between them is real and crash-injectable. This proves local at-least-once,
// NOT end-to-end exactly-once: naive mode displays every attempt.
import { DatabaseSync } from 'node:sqlite';

export interface SendResult {
  displayed: boolean;
  attempt: number;
}

export class ChannelDb {
  private db: DatabaseSync;
  readonly mode: 'naive' | 'dedup';

  private constructor(path: string, mode: 'naive' | 'dedup') {
    this.mode = mode;
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages(
        messageId TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL,
        body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS displays(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        messageId TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        at INTEGER NOT NULL
      );
    `);
  }

  static open(path: string, mode: 'naive' | 'dedup'): ChannelDb {
    return new ChannelDb(path, mode);
  }

  // One channel-local txn: ledger row + display row. Returns whether it actually displayed.
  send(messageId: string, conversationId: string, body: string, attempt: number, at: number): SendResult {
    let displayed = true;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare('INSERT OR IGNORE INTO messages(messageId, conversationId, body) VALUES (?, ?, ?)')
        .run(messageId, conversationId, body);
      if (this.mode === 'dedup') {
        const existing = this.db.prepare('SELECT 1 FROM displays WHERE messageId = ? LIMIT 1').get(messageId);
        if (existing) displayed = false;
      }
      if (displayed) {
        this.db.prepare('INSERT INTO displays(messageId, attempt, at) VALUES (?, ?, ?)').run(messageId, attempt, at);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return { displayed, attempt };
  }

  displayCount(messageId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM displays WHERE messageId = ?').get(messageId) as {
      c: number;
    };
    return row.c;
  }

  close(): void {
    this.db.close();
  }
}
