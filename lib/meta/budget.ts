/**
 * Hard spending cap for anything that calls the paid API. Every call reserves its
 * estimated cost first and throws once META_BUDGET_USD would be exceeded.
 */
export class Budget {
  private spent = 0;
  readonly lines: { label: string; usd: number }[] = [];

  constructor(readonly capUsd: number) {}

  static fromEnv(fallbackUsd = 0.25): Budget {
    const raw = Number(process.env.META_BUDGET_USD);
    return new Budget(Number.isFinite(raw) && raw >= 0 ? raw : fallbackUsd);
  }

  reserve(label: string, estimateUsd: number): void {
    if (this.spent + estimateUsd > this.capUsd) {
      throw new Error(
        `Budget stop before "${label}": $${(this.spent + estimateUsd).toFixed(4)} would exceed the $${this.capUsd} cap (META_BUDGET_USD).`,
      );
    }
    this.spent += estimateUsd;
  }

  /** Replace an estimate with the measured cost once usage comes back. */
  settle(label: string, estimateUsd: number, actualUsd: number): void {
    this.spent += actualUsd - estimateUsd;
    this.lines.push({ label, usd: actualUsd });
  }

  get totalUsd(): number {
    return this.spent;
  }
}
