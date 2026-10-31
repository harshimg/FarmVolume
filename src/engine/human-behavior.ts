// ============================================
// FarmVolume — Human Behavior Simulation Engine
// ============================================
//
// This module makes bot activity look like real human trading.
// It simulates natural patterns including:
// - Gaussian-distributed delays (not uniform)
// - Active trading sessions with breaks
// - Pair switching / distraction trades
// - Variable trade sizes with "round number" preference
// - Time-of-day awareness
// - Fatigue simulation
// - Random skips and micro-pauses
// ============================================

import { HumanBehaviorConfig, TokenPair } from '../types';
import { logger } from '../utils/logger';
import {
  gaussianRandom,
  clamp,
  randomBetween,
  randomIntBetween,
  humanRoundNumber,
  getCurrentUtcHour,
  isWeekend,
  isInHourRange,
  sleepSeconds,
  formatDuration,
} from '../utils/helpers';
import { getDistractionPairs } from '../utils/tokens';

/** Current behavioral state */
export interface BehaviorState {
  /** Number of trades executed in current active session */
  tradesInSession: number;
  /** Total trades since start */
  totalTrades: number;
  /** When the current active session started */
  sessionStartTime: number;
  /** Number of trades before next pair switch */
  tradesUntilSwitch: number;
  /** Is currently in a distraction phase? */
  inDistractionPhase: boolean;
  /** Remaining distraction trades */
  distractionTradesRemaining: number;
  /** Current fatigue multiplier */
  fatigueMultiplier: number;
  /** Is currently in a break? */
  inBreak: boolean;
  /** Current session number */
  sessionNumber: number;
}

/**
 * Human Behavior Simulator
 *
 * Coordinates all human-like behavior patterns to make
 * trading activity appear organic and natural.
 */
export class HumanBehaviorSimulator {
  private config: HumanBehaviorConfig;
  private state: BehaviorState;
  private primaryPairId: string;

  constructor(config: HumanBehaviorConfig, primaryPairId: string) {
    this.config = config;
    this.primaryPairId = primaryPairId;
    this.state = this.initState();
  }

  private initState(): BehaviorState {
    return {
      tradesInSession: 0,
      totalTrades: 0,
      sessionStartTime: Date.now(),
      tradesUntilSwitch: this.rollTradesUntilSwitch(),
      inDistractionPhase: false,
      distractionTradesRemaining: 0,
      fatigueMultiplier: 1.0,
      inBreak: false,
      sessionNumber: 1,
    };
  }

  /** Get current behavior state (for dashboard) */
  getState(): BehaviorState {
    return { ...this.state };
  }

  /**
   * Calculate the next delay before a trade.
   * Uses Gaussian distribution centered between min and max delays,
   * modified by fatigue, time-of-day, and weekend factors.
   */
  calculateNextDelay(): number {
    if (!this.config.enabled) return 1; // minimal delay if disabled

    const mean = (this.config.minDelaySeconds + this.config.maxDelaySeconds) / 2;
    const range = this.config.maxDelaySeconds - this.config.minDelaySeconds;
    const stdDev = range * this.config.delayGaussianFactor;

    // Base delay from Gaussian distribution
    let delay = gaussianRandom(mean, stdDev);

    // Clamp to valid range (allow slight overflow for natural feel)
    delay = clamp(
      delay,
      this.config.minDelaySeconds * 0.8,
      this.config.maxDelaySeconds * 1.3
    );

    // Apply fatigue multiplier
    delay *= this.state.fatigueMultiplier;

    // Apply time-of-day modifier
    const currentHour = getCurrentUtcHour();
    const isPeak = isInHourRange(
      currentHour,
      this.config.peakHoursUtc[0],
      this.config.peakHoursUtc[1]
    );
    if (!isPeak) {
      delay *= this.config.offPeakDelayMultiplier;
    }

    // Apply weekend modifier
    if (this.config.weekendReduction && isWeekend()) {
      delay *= this.config.weekendDelayMultiplier;
    }

    // Ensure minimum 2 seconds
    return Math.max(2, delay);
  }

  /**
   * Wait for the computed human-like delay.
   * Logs the wait reason for transparency.
   */
  async waitBeforeTrade(): Promise<void> {
    if (!this.config.enabled) return;

    const delay = this.calculateNextDelay();
    const reason = this.getDelayReason(delay);
    logger.humanBehavior(`Waiting ${formatDuration(delay)}`, reason);
    await sleepSeconds(delay);
  }

  /**
   * Determine if a micro-pause should happen before confirming a trade.
   * Simulates a human reviewing the quote before clicking "confirm".
   */
  async maybeDoMicroPause(): Promise<void> {
    if (!this.config.enabled) return;

    if (Math.random() < this.config.microPauseProbability) {
      const duration = randomBetween(
        this.config.microPauseDuration[0],
        this.config.microPauseDuration[1]
      );
      logger.humanBehavior('Reviewing quote...', `${duration.toFixed(1)}s pause`);
      await sleepSeconds(duration);
    }
  }

  /**
   * Determine if this trade should be skipped.
   * Simulates a human deciding not to trade after seeing the quote.
   */
  shouldSkipTrade(): boolean {
    if (!this.config.enabled) return false;

    if (Math.random() < this.config.skipTradeProbability) {
      logger.humanBehavior('Changed mind, skipping this trade');
      return true;
    }
    return false;
  }

  /**
   * Apply jitter to a trade size to make amounts look natural.
   * Sometimes rounds to "human-like" numbers (10, 25, 50, etc.)
   */
  applyTradeSizeJitter(baseSize: number): number {
    if (!this.config.enabled) return baseSize;

    // Apply random jitter
    const jitter = randomBetween(
      -this.config.tradeSizeJitterPercent,
      this.config.tradeSizeJitterPercent
    );
    let size = baseSize * (1 + jitter);

    // Maybe round to a "human" number
    if (Math.random() < this.config.roundNumberProbability) {
      size = humanRoundNumber(size);
      logger.humanBehavior('Using round number', `$${size}`);
    }

    // Ensure size is positive
    return Math.max(0.01, size);
  }

  /**
   * Check if it's time to switch to a distraction pair.
   * Returns the distraction pair to use, or null if staying on primary.
   */
  shouldSwitchToDistraction(): TokenPair | null {
    if (!this.config.enabled) return null;
    if (this.state.inDistractionPhase) return null; // already distracting

    this.state.tradesUntilSwitch--;

    if (this.state.tradesUntilSwitch <= 0) {
      // Time to switch!
      const distractionPairs =
        this.config.distractionPairs.length > 0
          ? this.config.distractionPairs
          : getDistractionPairs(this.primaryPairId);

      if (distractionPairs.length === 0) return null;

      // Pick a random distraction pair
      const pair = distractionPairs[Math.floor(Math.random() * distractionPairs.length)];

      // Set up distraction phase
      this.state.inDistractionPhase = true;
      this.state.distractionTradesRemaining = randomIntBetween(
        this.config.distractionTradesMin,
        this.config.distractionTradesMax
      );

      logger.humanBehavior(
        `Switching to ${pair.id} for ${this.state.distractionTradesRemaining} trades`,
        'pair rotation'
      );

      return pair;
    }

    return null;
  }

  /**
   * Process a completed distraction trade.
   * Returns true if distraction phase is over (back to primary pair).
   */
  processDistractionTrade(): boolean {
    if (!this.state.inDistractionPhase) return true;

    this.state.distractionTradesRemaining--;

    if (this.state.distractionTradesRemaining <= 0) {
      this.state.inDistractionPhase = false;
      this.state.tradesUntilSwitch = this.rollTradesUntilSwitch();
      logger.humanBehavior('Back to primary pair', 'distraction phase complete');
      return true;
    }

    return false;
  }

  /**
   * Check if a session break is needed.
   * Humans don't trade continuously — they take breaks.
   */
  async checkForSessionBreak(): Promise<void> {
    if (!this.config.enabled) return;

    const sessionDurationMinutes =
      (Date.now() - this.state.sessionStartTime) / (1000 * 60);

    const maxSessionMinutes = randomBetween(
      this.config.sessionActiveMinutesMin,
      this.config.sessionActiveMinutesMax
    );

    if (sessionDurationMinutes >= maxSessionMinutes) {
      // Time for a break
      const breakMinutes = randomBetween(
        this.config.sessionBreakMinutesMin,
        this.config.sessionBreakMinutesMax
      );

      this.state.inBreak = true;
      logger.humanBehavior(
        `Taking a break for ${formatDuration(breakMinutes * 60)}`,
        `session ${this.state.sessionNumber} lasted ${formatDuration(sessionDurationMinutes * 60)}`
      );

      await sleepSeconds(breakMinutes * 60);

      // Start new session
      this.state.inBreak = false;
      this.state.sessionNumber++;
      this.state.tradesInSession = 0;
      this.state.sessionStartTime = Date.now();
      this.state.fatigueMultiplier = 1.0; // Reset fatigue

      logger.humanBehavior(`Starting session ${this.state.sessionNumber}`, 'break over');
    }
  }

  /**
   * Update fatigue after each trade.
   * Delays gradually increase within a session to simulate tiredness.
   */
  updateFatigue(): void {
    if (!this.config.enabled) return;

    this.state.tradesInSession++;
    this.state.totalTrades++;

    // Increase fatigue based on trades in current session
    const fatigueIncrease = this.config.fatigueFactor - 1.0;
    this.state.fatigueMultiplier = clamp(
      1.0 + fatigueIncrease * this.state.tradesInSession * 0.1,
      1.0,
      this.config.fatigueMaxMultiplier
    );

    if (this.state.fatigueMultiplier > 1.1) {
      logger.humanBehavior(
        `Fatigue level: ${((this.state.fatigueMultiplier - 1) * 100).toFixed(0)}%`,
        'slowing down'
      );
    }
  }

  /**
   * Get a human-readable reason for the current delay
   */
  private getDelayReason(delay: number): string {
    const reasons: string[] = [];

    if (this.state.fatigueMultiplier > 1.1) {
      reasons.push('fatigue');
    }

    const isPeak = isInHourRange(
      getCurrentUtcHour(),
      this.config.peakHoursUtc[0],
      this.config.peakHoursUtc[1]
    );
    if (!isPeak) {
      reasons.push('off-peak hours');
    }

    if (isWeekend() && this.config.weekendReduction) {
      reasons.push('weekend');
    }

    if (reasons.length === 0) {
      const casual = ['browsing', 'thinking', 'checking chart', 'reading news', 'scrolling'];
      reasons.push(casual[Math.floor(Math.random() * casual.length)]);
    }

    return reasons.join(', ');
  }

  /**
   * Roll a random number of trades before next pair switch
   */
  private rollTradesUntilSwitch(): number {
    return randomIntBetween(
      this.config.pairSwitchAfterTradesMin,
      this.config.pairSwitchAfterTradesMax
    );
  }

  /**
   * Get the current phase as a string
   */
  getCurrentPhase(): 'active' | 'break' | 'distraction' {
    if (this.state.inBreak) return 'break';
    if (this.state.inDistractionPhase) return 'distraction';
    return 'active';
  }
}

// ============================================
// Default Human Behavior Configurations
// ============================================

/** Conservative/cautious trader profile */
export const CAUTIOUS_PROFILE: HumanBehaviorConfig = {
  enabled: true,
  minDelaySeconds: 15,
  maxDelaySeconds: 90,
  delayGaussianFactor: 0.3,
  sessionActiveMinutesMin: 8,
  sessionActiveMinutesMax: 20,
  sessionBreakMinutesMin: 5,
  sessionBreakMinutesMax: 25,
  pairSwitchAfterTradesMin: 3,
  pairSwitchAfterTradesMax: 8,
  distractionTradesMin: 1,
  distractionTradesMax: 2,
  distractionPairs: [],
  tradeSizeJitterPercent: 0.25,
  roundNumberProbability: 0.4,
  fatigueFactor: 1.3,
  fatigueMaxMultiplier: 2.0,
  skipTradeProbability: 0.08,
  microPauseProbability: 0.3,
  microPauseDuration: [1, 4],
  peakHoursUtc: [8, 22],
  offPeakDelayMultiplier: 2.5,
  weekendReduction: true,
  weekendDelayMultiplier: 2.0,
};

/** Active/moderate trader profile */
export const ACTIVE_PROFILE: HumanBehaviorConfig = {
  enabled: true,
  minDelaySeconds: 8,
  maxDelaySeconds: 45,
  delayGaussianFactor: 0.35,
  sessionActiveMinutesMin: 10,
  sessionActiveMinutesMax: 30,
  sessionBreakMinutesMin: 3,
  sessionBreakMinutesMax: 12,
  pairSwitchAfterTradesMin: 5,
  pairSwitchAfterTradesMax: 15,
  distractionTradesMin: 1,
  distractionTradesMax: 3,
  distractionPairs: [],
  tradeSizeJitterPercent: 0.2,
  roundNumberProbability: 0.3,
  fatigueFactor: 1.2,
  fatigueMaxMultiplier: 1.8,
  skipTradeProbability: 0.05,
  microPauseProbability: 0.25,
  microPauseDuration: [1, 3],
  peakHoursUtc: [6, 23],
  offPeakDelayMultiplier: 1.8,
  weekendReduction: true,
  weekendDelayMultiplier: 1.5,
};

/** Aggressive/whale trader profile */
export const AGGRESSIVE_PROFILE: HumanBehaviorConfig = {
  enabled: true,
  minDelaySeconds: 5,
  maxDelaySeconds: 25,
  delayGaussianFactor: 0.4,
  sessionActiveMinutesMin: 15,
  sessionActiveMinutesMax: 45,
  sessionBreakMinutesMin: 2,
  sessionBreakMinutesMax: 8,
  pairSwitchAfterTradesMin: 8,
  pairSwitchAfterTradesMax: 20,
  distractionTradesMin: 1,
  distractionTradesMax: 2,
  distractionPairs: [],
  tradeSizeJitterPercent: 0.15,
  roundNumberProbability: 0.2,
  fatigueFactor: 1.1,
  fatigueMaxMultiplier: 1.5,
  skipTradeProbability: 0.03,
  microPauseProbability: 0.15,
  microPauseDuration: [0.5, 2],
  peakHoursUtc: [0, 24],
  offPeakDelayMultiplier: 1.2,
  weekendReduction: false,
  weekendDelayMultiplier: 1.0,
};

/** No human behavior (pure bot mode — NOT recommended) */
export const BOT_PROFILE: HumanBehaviorConfig = {
  enabled: false,
  minDelaySeconds: 2,
  maxDelaySeconds: 5,
  delayGaussianFactor: 0.1,
  sessionActiveMinutesMin: 60,
  sessionActiveMinutesMax: 120,
  sessionBreakMinutesMin: 1,
  sessionBreakMinutesMax: 2,
  pairSwitchAfterTradesMin: 100,
  pairSwitchAfterTradesMax: 200,
  distractionTradesMin: 0,
  distractionTradesMax: 0,
  distractionPairs: [],
  tradeSizeJitterPercent: 0,
  roundNumberProbability: 0,
  fatigueFactor: 1.0,
  fatigueMaxMultiplier: 1.0,
  skipTradeProbability: 0,
  microPauseProbability: 0,
  microPauseDuration: [0, 0],
  peakHoursUtc: [0, 24],
  offPeakDelayMultiplier: 1.0,
  weekendReduction: false,
  weekendDelayMultiplier: 1.0,
};
