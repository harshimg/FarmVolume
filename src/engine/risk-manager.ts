// ============================================
// FarmVolume — Risk Management System
// ============================================

import { RiskConfig, SessionState, SwapQuote, Token } from '../types';
import { logger } from '../utils/logger';
import { formatUsd } from '../utils/helpers';

/** Risk check result */
export interface RiskCheckResult {
  allowed: boolean;
  reason?: string;
  severity: 'info' | 'warning' | 'critical';
}

/**
 * Risk Manager
 *
 * Monitors losses, enforces limits, and prevents
 * the engine from losing too much money.
 */
export class RiskManager {
  private config: RiskConfig;
  private dailyLossReset: number = 0;
  private currentDailyLoss: number = 0;
  private consecutiveFailures: number = 0;

  constructor(config: RiskConfig) {
    this.config = config;
    this.dailyLossReset = this.getNextMidnightUtc();
  }

  /**
   * Run all risk checks before executing a trade.
   */
  checkBeforeTrade(state: SessionState, quote: SwapQuote): RiskCheckResult {
    // Reset daily loss at midnight UTC
    this.checkDailyReset();

    // Check 1: Max total loss
    if (Math.abs(state.totalPnlUsd) >= this.config.maxTotalLossUsd && state.totalPnlUsd < 0) {
      return {
        allowed: false,
        reason: `Max total loss reached: ${formatUsd(Math.abs(state.totalPnlUsd))} >= ${formatUsd(this.config.maxTotalLossUsd)}`,
        severity: 'critical',
      };
    }

    // Check 2: Max loss percentage
    const lossPercent = Math.abs(state.totalPnlUsd) / (state.totalVolumeUsd || 1) * 100;
    if (state.totalPnlUsd < 0 && lossPercent >= this.config.maxTotalLossPercent) {
      return {
        allowed: false,
        reason: `Max loss percentage reached: ${lossPercent.toFixed(2)}% >= ${this.config.maxTotalLossPercent}%`,
        severity: 'critical',
      };
    }

    // Check 3: Daily loss cap
    if (this.currentDailyLoss >= this.config.dailyLossCapUsd) {
      return {
        allowed: false,
        reason: `Daily loss cap reached: ${formatUsd(this.currentDailyLoss)} >= ${formatUsd(this.config.dailyLossCapUsd)}`,
        severity: 'critical',
      };
    }

    // Check 4: Slippage check on quote
    const slippageBps =
      ((quote.inputAmount - quote.expectedOutputAmount) / quote.inputAmount) * 10000;
    if (Math.abs(slippageBps) > this.config.maxSlippageBps) {
      return {
        allowed: false,
        reason: `Slippage too high: ${slippageBps.toFixed(1)} bps (max ${this.config.maxSlippageBps})`,
        severity: 'warning',
      };
    }

    // Check 5: Price impact
    if (quote.priceImpactPercent > this.config.maxPriceImpactPercent) {
      return {
        allowed: false,
        reason: `Price impact too high: ${quote.priceImpactPercent.toFixed(2)}% (max ${this.config.maxPriceImpactPercent}%)`,
        severity: 'warning',
      };
    }

    // Check 6: Per-trade loss estimate
    const estimatedLoss = quote.inputAmount - quote.expectedOutputAmount + quote.estimatedFeeUsd;
    if (estimatedLoss > this.config.maxPerTradeLossUsd) {
      return {
        allowed: false,
        reason: `Estimated loss too high: ${formatUsd(estimatedLoss)} (max ${formatUsd(this.config.maxPerTradeLossUsd)})`,
        severity: 'warning',
      };
    }

    // Check 7: Consecutive failures
    if (this.consecutiveFailures >= this.config.maxConsecutiveFailures) {
      return {
        allowed: false,
        reason: `Too many consecutive failures: ${this.consecutiveFailures} (max ${this.config.maxConsecutiveFailures})`,
        severity: 'critical',
      };
    }

    return { allowed: true, severity: 'info' };
  }

  /**
   * Check SOL balance for gas fees.
   */
  async checkSolBalance(
    getBalance: () => Promise<number>
  ): Promise<RiskCheckResult> {
    try {
      const solBalance = await getBalance();
      if (solBalance < this.config.minSolBalance) {
        return {
          allowed: false,
          reason: `SOL balance too low for gas: ${solBalance.toFixed(4)} SOL (min ${this.config.minSolBalance})`,
          severity: 'critical',
        };
      }
      return { allowed: true, severity: 'info' };
    } catch (error) {
      return {
        allowed: false,
        reason: `Could not check SOL balance: ${(error as Error).message}`,
        severity: 'warning',
      };
    }
  }

  /**
   * Record a successful trade
   */
  recordSuccess(pnlUsd: number): void {
    this.consecutiveFailures = 0;
    if (pnlUsd < 0) {
      this.currentDailyLoss += Math.abs(pnlUsd);
    }
  }

  /**
   * Record a failed trade
   */
  recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.config.maxConsecutiveFailures) {
      logger.error(
        `${this.consecutiveFailures} consecutive failures — engine will pause`
      );
    }
  }

  /**
   * Get cooldown duration after a failure
   */
  getFailureCooldown(): number {
    // Exponential backoff: base * 2^failures (capped at 5 min)
    const cooldown = this.config.failedTradeCooldownSeconds * Math.pow(2, this.consecutiveFailures - 1);
    return Math.min(cooldown, 300);
  }

  /**
   * Reset consecutive failure counter (e.g., after manual intervention)
   */
  resetFailures(): void {
    this.consecutiveFailures = 0;
  }

  /**
   * Get current risk status summary
   */
  getStatus(): {
    consecutiveFailures: number;
    dailyLoss: number;
    dailyLossCap: number;
    dailyLossPercent: number;
  } {
    return {
      consecutiveFailures: this.consecutiveFailures,
      dailyLoss: this.currentDailyLoss,
      dailyLossCap: this.config.dailyLossCapUsd,
      dailyLossPercent: (this.currentDailyLoss / this.config.dailyLossCapUsd) * 100,
    };
  }

  private checkDailyReset(): void {
    if (Date.now() >= this.dailyLossReset) {
      logger.info(`Daily loss reset: ${formatUsd(this.currentDailyLoss)} → $0.00`);
      this.currentDailyLoss = 0;
      this.dailyLossReset = this.getNextMidnightUtc();
    }
  }

  private getNextMidnightUtc(): number {
    const now = new Date();
    const midnight = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0, 0, 0, 0
    ));
    return midnight.getTime();
  }
}
