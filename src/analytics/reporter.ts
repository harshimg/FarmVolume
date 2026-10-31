// ============================================
// FarmVolume — Analytics Reporter
// ============================================

import { TradeTracker } from './tracker';
import { SessionState, AnalyticsSnapshot, TradeRecord } from '../types';
import { formatUsd, formatBps, formatDuration, formatNumber } from '../utils/helpers';
import { logger } from '../utils/logger';

/**
 * Analytics Reporter
 *
 * Generates analytics snapshots, summaries, and reports
 * from tracked trade data.
 */
export class AnalyticsReporter {
  private tracker: TradeTracker;

  constructor(tracker: TradeTracker) {
    this.tracker = tracker;
  }

  getSnapshot(state: SessionState): AnalyticsSnapshot {
    const recentTrades = this.tracker.getRecentTrades(state.sessionId, 50);
    const hourlyVolume = this.tracker.getHourlyVolume(state.sessionId);
    const pnlOverTime = this.tracker.getPnlOverTime(state.sessionId);
    const stats = this.tracker.getSessionStats(state.sessionId);

    const confirmedTrades = recentTrades.filter(
      (t) => t.status === 'CONFIRMED' && t.actualSlippageBps !== undefined
    );
    const avgSlippage =
      confirmedTrades.length > 0
        ? confirmedTrades.reduce((sum, t) => sum + (t.actualSlippageBps || 0), 0) / confirmedTrades.length
        : 0;

    const avgFee = stats.successful > 0 ? stats.totalFees / stats.successful : 0;

    const sessionDurationHours = state.startedAt
      ? (Date.now() - state.startedAt) / (1000 * 3600)
      : 1;
    const volumePerHour =
      sessionDurationHours > 0 ? state.totalVolumeUsd / sessionDurationHours : 0;

    return {
      session: state,
      recentTrades,
      hourlyVolume,
      pnlOverTime,
      exchangeBreakdown: [
        {
          exchange: 'titan',
          volume: state.totalVolumeUsd,
          fees: state.totalFeesUsd,
        },
      ],
      avgSlippageBps: avgSlippage,
      avgFeePerTrade: avgFee,
      volumePerHour,
      estimatedTimeToTarget: null,
    };
  }

  printReport(sessionId: string): void {
    const stats = this.tracker.getSessionStats(sessionId);
    const hourly = this.tracker.getHourlyVolume(sessionId);

    logger.divider();
    logger.info('═══════════════════════════════════════');
    logger.info('         SESSION ANALYTICS REPORT      ');
    logger.info('═══════════════════════════════════════');
    logger.info('');
    logger.info(`📊 Trade Statistics:`);
    logger.info(`   Total Trades:      ${stats.totalTrades}`);
    logger.info(`   Successful:        ${stats.successful} (${((stats.successful / Math.max(stats.totalTrades, 1)) * 100).toFixed(1)}%)`);
    logger.info(`   Failed:            ${stats.failed}`);
    logger.info(`   Skipped:           ${stats.skipped}`);
    logger.info(`   Distraction:       ${stats.distractionTrades}`);
    logger.info('');
    logger.info(`💰 Financial Summary:`);
    logger.info(`   Total Volume:      ${formatUsd(stats.totalVolume)}`);
    logger.info(`   Total Fees:        ${formatUsd(stats.totalFees)}`);
    logger.info(`   Net P&L:           ${formatUsd(stats.totalPnl)} ${stats.totalPnl >= 0 ? '✅' : '❌'}`);
    logger.info(`   Avg Fee/Trade:     ${formatUsd(stats.successful > 0 ? stats.totalFees / stats.successful : 0)}`);
    logger.info(`   Avg Slippage:      ${formatBps(stats.avgSlippage)}`);
    logger.info('');

    if (hourly.length > 0) {
      logger.info(`📈 Hourly Volume:`);
      for (const h of hourly) {
        const bar = '█'.repeat(Math.min(40, Math.floor(h.volume / 10)));
        logger.info(`   ${h.hour} │ ${formatUsd(h.volume).padStart(10)} ${bar}`);
      }
    }

    logger.divider();
  }

  exportSession(sessionId: string): object {
    const stats = this.tracker.getSessionStats(sessionId);
    const trades = this.tracker.getSessionTrades(sessionId);
    const hourly = this.tracker.getHourlyVolume(sessionId);
    const pnl = this.tracker.getPnlOverTime(sessionId);

    return {
      sessionId,
      exportedAt: new Date().toISOString(),
      stats,
      hourlyVolume: hourly,
      pnlCurve: pnl,
      trades,
    };
  }
}

