/**
 * A failure circuit breaker for sandbox acquires (ERR-CTR-001).
 *
 * The engine's lifecycle sweep retries a failing environment test without a cap, and each retry used to full-clone the
 * template. After `threshold` failures inside `windowMs` the breaker opens: callers are refused at once, before any
 * Proxmox call, until a cooldown has passed. The cooldown starts at `cooldownMs`, doubles each time a trial attempt
 * fails again, and is capped at `maxCooldownMs`. One success resets everything.
 *
 * State lives in memory and, when a store is given (the plugin state API), is saved so a worker restart keeps it.
 * A store that fails never breaks the breaker; it falls back to memory.
 */
export interface BreakerOptions {
  /** Consecutive failures that open the breaker. 0 turns the breaker off. */
  threshold: number;
  windowMs: number;
  cooldownMs: number;
  maxCooldownMs: number;
}

export interface BreakerStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

interface State {
  failures: number[];
  trips: number;
  openUntil: number;
  lastError: string;
  lastFailureAt: number;
}

export class BreakerOpenError extends Error {
  readonly retryAfterMs: number;
  readonly lastError: string;
  constructor(retryAfterMs: number, lastError: string) {
    const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
    super(
      `The sandbox failure breaker is open: acquiring a container failed repeatedly, so nothing is being created. ` +
        `Retry after ${seconds >= 120 ? `${Math.ceil(seconds / 60)} min` : `${seconds} s`}. Last error: ${lastError}`,
    );
    this.name = "BreakerOpenError";
    this.retryAfterMs = retryAfterMs;
    this.lastError = lastError;
  }
}

function isState(value: unknown): value is State {
  const v = value as State | null;
  return !!v && Array.isArray(v.failures) && typeof v.trips === "number" && typeof v.openUntil === "number";
}

export class Breaker {
  private readonly memory = new Map<string, State>();
  private readonly now: () => number;
  private readonly store?: BreakerStore;

  constructor(options: { now?: () => number; store?: BreakerStore } = {}) {
    this.now = options.now ?? Date.now;
    this.store = options.store;
  }

  private async load(key: string): Promise<State | undefined> {
    const known = this.memory.get(key);
    if (known || !this.store) return known;
    try {
      const saved = await this.store.get(key);
      if (isState(saved)) {
        this.memory.set(key, saved);
        return saved;
      }
    } catch {
      // memory only
    }
    return undefined;
  }

  private async save(key: string, state: State | null): Promise<void> {
    if (state) this.memory.set(key, state);
    else this.memory.delete(key);
    try {
      await this.store?.set(key, state);
    } catch {
      // memory only
    }
  }

  /** Throws BreakerOpenError while the breaker is open. After the cooldown the next call is the trial. */
  async check(key: string, options: BreakerOptions): Promise<void> {
    if (options.threshold <= 0) return;
    const state = await this.load(key);
    if (state && state.openUntil > this.now()) throw new BreakerOpenError(state.openUntil - this.now(), state.lastError);
  }

  async failure(key: string, options: BreakerOptions, error: unknown): Promise<void> {
    if (options.threshold <= 0) return;
    const now = this.now();
    const state = (await this.load(key)) ?? { failures: [], trips: 0, openUntil: 0, lastError: "", lastFailureAt: 0 };
    state.failures = [...state.failures.filter((at) => at > now - options.windowMs), now];
    state.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    state.lastFailureAt = now;
    // A failed trial (trips > 0) re-opens at once, even if the earlier failures have aged out of the window.
    if (state.trips > 0 || state.failures.length >= options.threshold) {
      state.trips += 1;
      state.openUntil = now + Math.min(options.cooldownMs * 2 ** (state.trips - 1), options.maxCooldownMs);
    }
    await this.save(key, state);
  }

  async success(key: string): Promise<void> {
    if (this.memory.has(key) || this.store) await this.save(key, null);
  }
}
