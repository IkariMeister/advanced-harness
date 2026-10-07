import { randomBytes } from 'node:crypto';

export class ApprovalChallenges {
  #entries = new Map<string, { target: string; expiresAt: number }>();
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  constructor(now: () => number = Date.now, ttlMs = 60_000, maxEntries = 64) {
    this.#now = now;
    this.#ttlMs = ttlMs;
    this.#maxEntries = maxEntries;
  }

  issue(target: string): string {
    this.#expire();
    if (this.#entries.size >= this.#maxEntries) throw new Error('Too many pending approval challenges');
    const nonce = randomBytes(32).toString('hex');
    this.#entries.set(nonce, { target, expiresAt: this.#now() + this.#ttlMs });
    return nonce;
  }

  consume(target: string, nonce: string): boolean {
    const entry = this.#entries.get(nonce);
    this.#entries.delete(nonce);
    return Boolean(entry && entry.expiresAt > this.#now() && entry.target === target);
  }

  clear(): void { this.#entries.clear(); }

  #expire(): void {
    const now = this.#now();
    for (const [nonce, entry] of this.#entries) if (entry.expiresAt <= now) this.#entries.delete(nonce);
  }
}
