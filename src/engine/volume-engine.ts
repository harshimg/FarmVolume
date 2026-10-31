// ============================================
// FarmVolume — Volume Generation Engine
// ============================================
//
// The core orchestration engine that runs the volume
// generation loop with human-like behavior simulation.
// ============================================

import { EventEmitter } from 'events';
import {
  SessionConfig,
  SessionState,
  TradeRecord,
  TradeDirection,
  TradeStatus,
  TokenPair,
  SwapQuote,
  SwapResult,
  IExchangeAdapter,
} from '../types';
import { logger } from '../utils/logger';
import { formatUsd, formatDuration, formatBps, sleepSeconds, generateSessionId } from '../utils/helpers';
import { HumanBehaviorSimulator } from './human-behavior';
import { TradeOptimizer } from './trade-optimizer';
import { RiskManager } from './risk-manager';
import { TOKENS } from '../utils/tokens';
import { v4 as uuidv4 } from 'uuid';

/**
 * Volume Generation Engine
 *
 * Orchestrates the complete volume generation process:
 * 1. Initializes exchange connection
 * 2. Runs continuous swap cycles (A→B, B→A)
 * 3. Applies human behavior simulation
 * 4. Manages risk and tracks analytics
 * 5. Emits events for dashboard/monitoring
 */
export class VolumeEngine extends EventEmitter {
  private exchange: IExchangeAdapter;
  private config: SessionConfig;
  private state: SessionState;
  private humanSim: HumanBehaviorSimulator;
  private optimizer: TradeOptimizer;
  private riskManager: RiskManager;
  private running: boolean = false;
  private pauseRequested: boolean = false;
  private stopRequested: boolean = false;

  constructor(exchange: IExchangeAdapter, config: SessionConfig) {
    super();
    this.exchange = exchange;
    this.config = config;

    // Initialize state
    this.state = {
      sessionId: config.id || generateSessionId(),
      status: 'idle',
      totalSwaps: 0,
      totalCycles: 0,
      successfulSwaps: 0,
      failedSwaps: 0,
      skippedSwaps: 0,
      distractionSwaps: 0,
      totalVolumeUsd: 0,
      totalFeesUsd: 0,
      totalPnlUsd: 0,
      currentBalanceA: 0,
      currentBalanceB: 0,
      currentPhase: 'active',
      tradesInCurrentBurst: 0,
      tradesUntilPairSwitch: 0,
      currentFatigueMultiplier: 1.0,
      consecutiveFailures: 0,
      dailyLossUsd: 0,
    };

    // Initialize subsystems
    this.humanSim = new HumanBehaviorSimulator(
      config.humanBehavior,
      config.primaryPair.id
    );
    this.optimizer = new TradeOptimizer(config.optimizer);
    this.riskManager = new RiskManager(config.risk);
  }

  /** Get current session state */
  getState(): SessionState {
    return { ...this.state };
  }

  /** Start the volume generation engine */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('Engine is already running');
      return;
    }

    logger.banner();
    logger.divider();
    logger.info(`Session: ${this.state.sessionId}`);
    logger.info(`Exchange: ${this.exchange.name}`);
    logger.info(`Primary Pair: ${this.config.primaryPair.id}`);
    logger.info(`Allocated Funds: ${formatUsd(this.config.allocatedFundsUsd)}`);
    logger.info(`Trade Size: ${formatUsd(this.config.tradeSizeRange[0])} - ${formatUsd(this.config.tradeSizeRange[1])}`);
    logger.info(`Target Volume: ${this.config.targetVolumeUsd > 0 ? formatUsd(this.config.targetVolumeUsd) : 'Unlimited'}`);
    logger.info(`Human Behavior: ${this.config.humanBehavior.enabled ? 'ENABLED ✓' : 'DISABLED'}`);
    logger.divider();

    this.running = true;
    this.stopRequested = false;
    this.pauseRequested = false;
    this.state.status = 'running';
    this.state.startedAt = Date.now();

    // Connect to exchange
    if (!this.exchange.isConnected()) {
      await this.exchange.connect();
    }

    // Get initial balances
    await this.updateBalances();
    logger.info(
      `Initial Balances: ${this.state.currentBalanceA} ${this.config.primaryPair.tokenA.symbol}, ` +
      `${this.state.currentBalanceB} ${this.config.primaryPair.tokenB.symbol}`
    );
    logger.divider();

    this.emit('started', this.state);

    // Main loop
    try {
      await this.runLoop();
    } catch (error) {
      logger.error(`Engine error: ${(error as Error).message}`);
      this.state.status = 'error';
      this.state.lastError = (error as Error).message;
      this.emit('error', error);
    } finally {
      this.running = false;
      if (this.state.status !== 'error') {
        this.state.status = 'stopped';
      }
      this.state.stoppedAt = Date.now();
      this.printSummary();
      this.emit('stopped', this.state);
    }
  }

  /** Pause the engine */
  pause(): void {
    if (!this.running) return;
    this.pauseRequested = true;
    this.state.status = 'paused';
    this.state.pausedAt = Date.now();
    logger.warn('Engine pausing after current trade...');
    this.emit('paused', this.state);
  }

  /** Resume the engine */
  resume(): void {
    if (!this.pauseRequested) return;
    this.pauseRequested = false;
    this.state.status = 'running';
    logger.info('Engine resumed');
    this.emit('resumed', this.state);
  }

  /** Stop the engine */
  stop(): void {
    this.stopRequested = true;
    logger.warn('Engine stopping after current trade...');
  }

  /** Emergency stop — immediate halt */
  emergencyStop(): void {
    this.stopRequested = true;
    this.running = false;
    this.state.status = 'stopped';
    this.state.stoppedAt = Date.now();
    logger.error('🚨 EMERGENCY STOP — Engine halted immediately');
    this.emit('emergency_stop', this.state);
  }

  // ============================================
  // Main Engine Loop
  // ============================================

  private async runLoop(): Promise<void> {
    let direction: TradeDirection = TradeDirection.A_TO_B;
    let currentPair: TokenPair = this.config.primaryPair;
    let isDistraction = false;

    while (!this.stopRequested) {
      // Check for pause
      while (this.pauseRequested && !this.stopRequested) {
        await sleepSeconds(1);
      }
      if (this.stopRequested) break;

      // Check session limits
      if (this.shouldStopSession()) break;

      // Check for session break (human behavior)
      await this.humanSim.checkForSessionBreak();

      // Check for pair switching (human behavior)
      const distractionPair = this.humanSim.shouldSwitchToDistraction();
      if (distractionPair) {
        currentPair = distractionPair;
        isDistraction = true;
        direction = TradeDirection.A_TO_B; // Reset direction for new pair
      } else if (isDistraction) {
        // Check if distraction phase is over
        const done = this.humanSim.processDistractionTrade();
        if (done) {
          currentPair = this.config.primaryPair;
          isDistraction = false;
        }
      }

      // Wait with human-like delay
      await this.humanSim.waitBeforeTrade();

      // Check if human sim wants to skip this trade
      if (this.humanSim.shouldSkipTrade()) {
        this.state.skippedSwaps++;
        this.emit('trade_skipped', { reason: 'human_skip' });
        continue;
      }

      // Determine trade size
      const baseSize = this.getTradeSize();
      const adjustedSize = this.humanSim.applyTradeSizeJitter(baseSize);

      // Execute the swap
      const tradeRecord = await this.executeTrade(
        currentPair,
        direction,
        adjustedSize,
        isDistraction
      );

      if (tradeRecord) {
        this.emit('trade', tradeRecord);

        // Update fatigue
        this.humanSim.updateFatigue();

        // Process distraction completion
        if (isDistraction) {
          this.humanSim.processDistractionTrade();
        }
      }

      // Alternate direction for next trade (complete the cycle)
      direction = direction === TradeDirection.A_TO_B
        ? TradeDirection.B_TO_A
        : TradeDirection.A_TO_B;

      // Count cycles (A→B + B→A = 1 cycle)
      if (direction === TradeDirection.A_TO_B) {
        this.state.totalCycles++;
      }

      // Update state for dashboard
      this.updateDashboardState();

      // Log periodic stats every 10 trades
      if (this.state.totalSwaps > 0 && this.state.totalSwaps % 10 === 0) {
        logger.volume(this.state.totalVolumeUsd, this.state.totalPnlUsd, this.state.totalFeesUsd);
      }
    }
  }

  // ============================================
  // Trade Execution
  // ============================================

  private async executeTrade(
    pair: TokenPair,
    direction: TradeDirection,
    amountUsd: number,
    isDistraction: boolean
  ): Promise<TradeRecord | null> {
    const inputToken = direction === TradeDirection.A_TO_B ? pair.tokenA : pair.tokenB;
    const outputToken = direction === TradeDirection.A_TO_B ? pair.tokenB : pair.tokenA;

    const tradeId = uuidv4();

    logger.info(
      `${isDistraction ? '🎭 ' : ''}Swapping ${amountUsd.toFixed(2)} ${inputToken.symbol} → ${outputToken.symbol} on ${this.exchange.name}`
    );

    try {
      // Check SOL balance for gas
      const solCheck = await this.riskManager.checkSolBalance(
        () => this.exchange.getBalance(TOKENS.SOL)
      );
      if (!solCheck.allowed) {
        logger.error(solCheck.reason!);
        return this.createTradeRecord(tradeId, pair.id, direction, amountUsd, TradeStatus.SKIPPED, isDistraction, solCheck.reason);
      }

      // Get quote (with optional trade splitting)
      const chunks = this.optimizer.splitTrade(amountUsd);
      let totalOutput = 0;
      let totalFees = 0;
      let lastQuote: SwapQuote | null = null;

      for (const chunk of chunks) {
        // Calculate input amount in token terms
        const tokenAmount = this.usdToTokenAmount(chunk.inputAmount, inputToken);

        // Get quote
        const quote = await this.exchange.getQuote(
          inputToken,
          outputToken,
          tokenAmount,
          this.config.risk.maxSlippageBps
        );
        lastQuote = quote;

        // Risk check
        const riskCheck = this.riskManager.checkBeforeTrade(this.state, quote);
        if (!riskCheck.allowed) {
          logger.warn(`Risk check failed: ${riskCheck.reason}`);
          if (riskCheck.severity === 'critical') {
            this.stop();
            return this.createTradeRecord(tradeId, pair.id, direction, amountUsd, TradeStatus.SKIPPED, isDistraction, riskCheck.reason);
          }
          continue; // Skip this chunk
        }

        // Human micro-pause (reviewing the quote)
        await this.humanSim.maybeDoMicroPause();

        // Execute the swap
        const result = await this.exchange.executeSwap(quote);

        if (result.success) {
          totalOutput += result.outputAmount;
          totalFees += result.feePaid;
          this.riskManager.recordSuccess(result.feePaid * -1);

          logger.trade(
            direction,
            tokenAmount,
            inputToken.symbol,
            result.outputAmount,
            outputToken.symbol
          );
        } else {
          this.riskManager.recordFailure();
          logger.error(`Chunk ${chunk.index + 1} failed: ${result.error}`);

          // Apply failure cooldown
          const cooldown = this.riskManager.getFailureCooldown();
          if (cooldown > 0) {
            logger.warn(`Cooling down for ${formatDuration(cooldown)}`);
            await sleepSeconds(cooldown);
          }

          return this.createTradeRecord(
            tradeId, pair.id, direction, amountUsd,
            TradeStatus.FAILED, isDistraction, result.error,
            result.txSignature
          );
        }
      }

      // Calculate P&L
      const inputUsd = amountUsd;
      const outputUsd = this.tokenAmountToUsd(totalOutput, outputToken);
      const pnl = outputUsd - inputUsd - totalFees;

      // Update state
      this.state.totalSwaps++;
      this.state.successfulSwaps++;
      this.state.totalVolumeUsd += inputUsd;
      this.state.totalFeesUsd += totalFees;
      this.state.totalPnlUsd += pnl;
      if (isDistraction) this.state.distractionSwaps++;

      // Update balances
      await this.updateBalances();

      return this.createTradeRecord(
        tradeId, pair.id, direction, amountUsd,
        TradeStatus.CONFIRMED, isDistraction, undefined,
        lastQuote?.rawTransaction ? 'confirmed' : undefined,
        totalOutput, pnl, totalFees
      );
    } catch (error) {
      const errMsg = (error as Error).message;
      logger.error(`Trade execution error: ${errMsg}`);
      this.state.failedSwaps++;
      this.riskManager.recordFailure();
      return this.createTradeRecord(tradeId, pair.id, direction, amountUsd, TradeStatus.FAILED, isDistraction, errMsg);
    }
  }

  // ============================================
  // Helper Methods
  // ============================================

  private getTradeSize(): number {
    const [min, max] = this.config.tradeSizeRange;
    return min + Math.random() * (max - min);
  }

  private usdToTokenAmount(usdAmount: number, token: { priceUsd?: number; symbol: string }): number {
    // For stablecoins, 1 token ≈ $1
    if (['USDC', 'USDT'].includes(token.symbol)) {
      return usdAmount;
    }
    // Use stored price or estimate
    const price = token.priceUsd || 1;
    return usdAmount / price;
  }

  private tokenAmountToUsd(amount: number, token: { priceUsd?: number; symbol: string }): number {
    if (['USDC', 'USDT'].includes(token.symbol)) {
      return amount;
    }
    return amount * (token.priceUsd || 1);
  }

  private async updateBalances(): Promise<void> {
    try {
      const [balA, balB] = await Promise.all([
        this.exchange.getBalance(this.config.primaryPair.tokenA),
        this.exchange.getBalance(this.config.primaryPair.tokenB),
      ]);
      this.state.currentBalanceA = balA;
      this.state.currentBalanceB = balB;
    } catch (error) {
      logger.debug(`Balance update failed: ${(error as Error).message}`);
    }
  }

  private shouldStopSession(): boolean {
    // Check target volume
    if (
      this.config.targetVolumeUsd > 0 &&
      this.state.totalVolumeUsd >= this.config.targetVolumeUsd
    ) {
      logger.success(`🎯 Target volume reached: ${formatUsd(this.state.totalVolumeUsd)}`);
      return true;
    }

    // Check max duration
    if (
      this.config.maxDurationMinutes > 0 &&
      this.state.startedAt
    ) {
      const elapsed = (Date.now() - this.state.startedAt) / (1000 * 60);
      if (elapsed >= this.config.maxDurationMinutes) {
        logger.info(`Max duration reached: ${formatDuration(elapsed * 60)}`);
        return true;
      }
    }

    // Check max cycles
    if (
      this.config.maxCycles > 0 &&
      this.state.totalCycles >= this.config.maxCycles
    ) {
      logger.info(`Max cycles reached: ${this.state.totalCycles}`);
      return true;
    }

    return false;
  }

  private updateDashboardState(): void {
    const behaviorState = this.humanSim.getState();
    this.state.currentPhase = this.humanSim.getCurrentPhase();
    this.state.tradesInCurrentBurst = behaviorState.tradesInSession;
    this.state.tradesUntilPairSwitch = behaviorState.tradesUntilSwitch;
    this.state.currentFatigueMultiplier = behaviorState.fatigueMultiplier;
    this.state.consecutiveFailures = this.riskManager.getStatus().consecutiveFailures;
    this.state.dailyLossUsd = this.riskManager.getStatus().dailyLoss;
  }

  private createTradeRecord(
    id: string,
    pairId: string,
    direction: TradeDirection,
    inputAmount: number,
    status: TradeStatus,
    isDistraction: boolean,
    error?: string,
    txSignature?: string,
    actualOutput?: number,
    pnl?: number,
    fees?: number
  ): TradeRecord {
    const pair = pairId === this.config.primaryPair.id
      ? this.config.primaryPair
      : { tokenA: { symbol: '?' }, tokenB: { symbol: '?' } };

    return {
      id,
      sessionId: this.state.sessionId,
      pairId,
      exchange: this.exchange.id,
      direction,
      status,
      inputToken: direction === TradeDirection.A_TO_B ? pair.tokenA.symbol : pair.tokenB.symbol,
      outputToken: direction === TradeDirection.A_TO_B ? pair.tokenB.symbol : pair.tokenA.symbol,
      inputAmount,
      expectedOutputAmount: inputAmount, // approximate for stables
      actualOutputAmount: actualOutput,
      slippageBps: this.config.risk.maxSlippageBps,
      actualSlippageBps: actualOutput ? ((inputAmount - actualOutput) / inputAmount) * 10000 : undefined,
      feePaidUsd: fees || 0,
      pnlUsd: pnl || 0,
      txSignature,
      error,
      isDistraction,
      createdAt: Date.now(),
      executedAt: status === TradeStatus.CONFIRMED ? Date.now() : undefined,
    };
  }

  private printSummary(): void {
    logger.divider();
    logger.info('═══ SESSION SUMMARY ═══');
    logger.info(`Session ID:    ${this.state.sessionId}`);
    logger.info(`Duration:      ${this.state.startedAt ? formatDuration((Date.now() - this.state.startedAt) / 1000) : 'N/A'}`);
    logger.info(`Total Swaps:   ${this.state.totalSwaps} (${this.state.successfulSwaps} ok, ${this.state.failedSwaps} failed, ${this.state.skippedSwaps} skipped)`);
    logger.info(`Total Cycles:  ${this.state.totalCycles}`);
    logger.info(`Volume:        ${formatUsd(this.state.totalVolumeUsd)}`);
    logger.info(`Fees Paid:     ${formatUsd(this.state.totalFeesUsd)}`);
    const pnlColor = this.state.totalPnlUsd >= 0 ? '✅' : '❌';
    logger.info(`Net P&L:       ${pnlColor} ${formatUsd(this.state.totalPnlUsd)}`);
    logger.info(`Distraction:   ${this.state.distractionSwaps} trades on other pairs`);
    logger.divider();
  }
}
