import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { audit, emptyState, hash, requireThat, stateSchema, type State } from './protocol.ts';
import { randomUUID } from 'node:crypto';

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith('../') && !path.startsWith('..\\') && !isAbsolute(path));
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/** Trusted host storage. Never hand this object, its path, or its methods to an agent. */
export class Store {
  #db: DatabaseSync;
  #token = randomUUID();
  #project: string;
  #closed = false;

  constructor(options: { database: string; worktree: string; project: string; feature: string; snapshot: string }) {
    const worktree = realpathSync(options.worktree);
    const database = resolve(options.database);
    requireThat(!isWithin(worktree, database), 'Operational state must be outside the worktree');
    mkdirSync(dirname(database), { recursive: true });
    requireThat(!isWithin(worktree, realpathSync(dirname(database))), 'State directory resolves inside the worktree');
    if (existsSync(database)) requireThat(!isWithin(worktree, realpathSync(database)), 'State file resolves inside the worktree');
    this.#project = options.project;
    this.#db = new DatabaseSync(database);
    this.#db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.#db.exec('CREATE TABLE IF NOT EXISTS features (project TEXT PRIMARY KEY, json TEXT NOT NULL, checksum TEXT NOT NULL)');
    try {
      this.#transaction(() => {
        let state = this.#read();
        if (state) {
          requireThat(state.feature === options.feature, 'Another feature is active for this project');
          requireThat(!state.owner || !alive(state.owner.pid), 'Another controller owns this project');
          state.paused = 'Human-confirmed resume required';
          for (const operation of Object.values(state.operations)) {
            if (operation.status === 'pending') operation.status = 'uncertain';
          }
          audit(state, 'reopened', 'Previous operations must be reconciled before resuming');
        } else {
          state = emptyState(options.project, options.feature, options.snapshot);
          audit(state, 'created', options.feature);
        }
        state.owner = { token: this.#token, pid: process.pid };
        this.#write(state);
      });
    } catch (error) { this.#db.close(); throw error; }
  }

  #read(): State | undefined {
    const row = this.#db.prepare('SELECT json, checksum FROM features WHERE project = ?').get(this.#project);
    if (!row) return undefined;
    requireThat(typeof row.json === 'string' && row.checksum === hash(row.json), 'State integrity failure; ask the human');
    const state = stateSchema.parse(JSON.parse(row.json));
    requireThat(state.project === this.#project, 'Project state mismatch');
    return state;
  }

  #write(state: State): void {
    const json = JSON.stringify(stateSchema.parse(state));
    this.#db.prepare('INSERT INTO features VALUES (?, ?, ?) ON CONFLICT(project) DO UPDATE SET json=excluded.json, checksum=excluded.checksum')
      .run(this.#project, json, hash(json));
  }

  #transaction<T>(fn: () => T): T {
    requireThat(!this.#closed, 'Controller is closed');
    this.#db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.#db.exec('COMMIT'); return result; }
    catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }

  update<T>(fn: (state: State) => T): T {
    return this.#transaction(() => {
      const state = this.#read();
      requireThat(state && state.owner?.token === this.#token, 'Controller ownership lost');
      const result = fn(state);
      this.#write(state);
      return structuredClone(result);
    });
  }

  view(): State { return this.update(state => state); }

  close(): void {
    if (this.#closed) return;
    this.update(state => {
      requireThat(!Object.values(state.operations).some(op => op.status === 'pending'), 'An action is still running');
      state.owner = null;
      state.paused = 'Human-confirmed resume required';
      audit(state, 'closed', 'Controller released');
    });
    this.#db.close();
    this.#closed = true;
  }
}
