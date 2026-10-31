// ============================================
// FarmVolume — Trade Tracker (JSON File Store)
// ============================================

import fs from 'fs';
import path from 'path';
import { TradeRecord, TradeStatus } from '../types';
import { logger } from '../utils/logger';

interface DatabaseSchema {
  trades: TradeRecord[];
  sessions: Record<string, any>;
}

/**
 * Trade Tracker
 *
 * Persists all trade records and session stats to a local JSON file
 * with zero native compilation dependencies (compatible across all Node versions).
 */
export class TradeTracker {
  private filePath: string;
  private data: DatabaseSchema;

  constructor(dbPath?: string) {
    this.filePath = dbPath || path.join(process.cwd(), 'farmvolume_db.json');
    this.data = { trades: [], sessions: {} };
    this.initialize();
    logger.debug(`Trade tracker initialized: ${this.filePath}`);
  }

  private initialize(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        this.data = JSON.parse(raw);
        if (!this.data.trades) this.data.trades = [];
        if (!this.data.sessions) this.data.sessions = {};
      } else {
        this.save();
      }
    } catch (e) {
      this.data = { trades: [], sessions: {} };
    }
  }

  private save(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (err) {
      logger.error(`Failed to save database file: ${(err as Error).message}`);
    }
  }

  recordTrade(trade: TradeRecord): void {
    const existingIndex = this.data.trades.findIndex((t) => t.id === trade.id);
    if (existingIndex >= 0) {
      this.data.trades[existingIndex] = trade;
    } else {
      this.data.trades.push(trade);
    }
    this.save();
  }

  saveSession(sessionId: string, data: Record<string, any>): void {
    this.data.sessions[sessionId] = {
      ...(this.data.sessions[sessionId] || {}),
      id: sessionId,
      ...data,
    };
    this.save();
  }

  getRecentTrades(sessionId?: string, limit: number = 50): TradeRecord[] {
    let list = this.data.trades;
    if (sessionId) {
      list = list.filter((t) => t.sessionId === sessionId);
    }
    return list.slice().reverse().slice(0, limit);
  }

  getSessionTrades(sessionId: string): TradeRecord[] {
    return this.data.trades.filter((t) => t.sessionId === sessionId);
  }

  getSessionStats(sessionId: string): {
    totalTrades: number;
    successful: number;
    failed: number;
    skipped: number;
    totalVolume: number;
    totalFees: number;
    totalPnl: number;
    avgSlippage: number;
    distractionTrades: number;
  } {
    const trades = this.data.trades.filter((t) => t.sessionId === sessionId);

    let successful = 0;
    let failed = 0;
    let skipped = 0;
    let totalVolume = 0;
    let totalFees = 0;
    let totalPnl = 0;
    let slippageSum = 0;
    let slippageCount = 0;
    let distractionTrades = 0;

    for (const t of trades) {
      if (t.status === 'CONFIRMED') {
        successful++;
        totalVolume += t.inputAmount;
      } else if (t.status === 'FAILED') {
        failed++;
      } else if (t.status === 'SKIPPED') {
        skipped++;
      }

      totalFees += t.feePaidUsd || 0;
      totalPnl += t.pnlUsd || 0;

      if (t.actualSlippageBps !== undefined) {
        slippageSum += t.actualSlippageBps;
        slippageCount++;
      }

      if (t.isDistraction) {
        distractionTrades++;
      }
    }

    return {
      totalTrades: trades.length,
      successful,
      failed,
      skipped,
      totalVolume,
      totalFees,
      totalPnl,
      avgSlippage: slippageCount > 0 ? slippageSum / slippageCount : 0,
      distractionTrades,
    };
  }

  getHourlyVolume(sessionId: string): { hour: string; volume: number }[] {
    const trades = this.data.trades.filter(
      (t) => t.sessionId === sessionId && t.status === 'CONFIRMED'
    );

    const map = new Map<string, number>();
    for (const t of trades) {
      const date = new Date(t.createdAt);
      const hour = `${date.toISOString().substring(0, 13)}:00`;
      map.set(hour, (map.get(hour) || 0) + t.inputAmount);
    }

    return Array.from(map.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([hour, volume]) => ({ hour, volume }));
  }

  getPnlOverTime(sessionId: string): { time: number; pnl: number }[] {
    const trades = this.data.trades
      .filter((t) => t.sessionId === sessionId && t.status === 'CONFIRMED')
      .sort((a, b) => a.createdAt - b.createdAt);

    let cumPnl = 0;
    return trades.map((t) => {
      cumPnl += t.pnlUsd || 0;
      return { time: t.createdAt, pnl: cumPnl };
    });
  }

  listSessions(): any[] {
    return Object.values(this.data.sessions);
  }

  close(): void {
    this.save();
  }
}
