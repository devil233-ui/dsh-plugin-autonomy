/**
 * Durable record of turns replaced by the quiet-window notice.
 *
 * The plugin logger does not reach the host log file, so the same line is also
 * written to stdout (which systemd appends to /var/log/dsh-web.log) and to a
 * JSONL file under the plugin data directory.
 */

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

export const SUPPRESSED_LOG = 'suppressed.log';

export interface SuppressedEntry {
  at: number;
  sessionId: string;
  reason: string;
  chat?: string;
  excerpt: string;
}

export function appendSuppressed(dataDir: string, entry: SuppressedEntry): void {
  try {
    appendFileSync(join(dataDir, SUPPRESSED_LOG), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // the stdout line below is the fallback when the file cannot be written
  }
}
