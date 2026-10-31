// ============================================
// FarmVolume — Trade Optimizer
// ============================================
//
// Splits large trades into smaller chunks and optimizes
// execution to minimize slippage and fees.
// ============================================

import {
  Token,
  SwapQuote,
  IExchangeAdapter,
  OptimizerConfig,
} from '../types';
import { logger } from '../utils/logger';
import { randomBetween, sleepSeconds, formatUsd } from '../utils/helpers';

/** A chunk of a split trade */
export interface TradeChunk {
  index: number;
  totalChunks: number;
  inputAmount: number;
  quote?: SwapQuote;
}

/**
 * Trade Optimizer
 *
 * Analyzes trade sizes and splits them into optimal chunks
 * to reduce price impact and slippage.
 */
export class TradeOptimizer {
  private config: OptimizerConfig;

  constructor(config: OptimizerConfig) {
    this.config = config;
  }

  /**
   * Determine if a trade should be split into chunks.
   */
  shouldSplit(amountUsd: number): boolean {
    return amountUsd > this.config.splitThresholdUsd;
  }

  /**
   * Split a trade amount into optimized chunks.
   *
   * Uses variable-sized chunks (not uniform) to look more natural.
   * Larger trades get more chunks, but each chunk stays above minimum size.
   */
  splitTrade(totalAmountUsd: number): TradeChunk[] {
    if (!this.shouldSplit(totalAmountUsd)) {
      return [{
        index: 0,
        totalChunks: 1,
        inputAmount: totalAmountUsd,
      }];
    }

    // Calculate optimal number of chunks
    let numChunks = Math.ceil(totalAmountUsd / this.config.splitThresholdUsd);
    numChunks = Math.min(numChunks, this.config.maxChunks);

    // Ensure minimum chunk size
    while (numChunks > 1 && totalAmountUsd / numChunks < this.config.minChunkSizeUsd) {
      numChunks--;
    }

    // Create variable-sized chunks (not perfectly equal)
    const chunks: TradeChunk[] = [];
    let remaining = totalAmountUsd;

    for (let i = 0; i < numChunks; i++) {
      const isLast = i === numChunks - 1;

      if (isLast) {
        // Last chunk gets whatever remains
        chunks.push({
          index: i,
          totalChunks: numChunks,
          inputAmount: remaining,
        });
      } else {
        // Add some variation to chunk size (±15%)
        const baseChunkSize = remaining / (numChunks - i);
        const variation = randomBetween(0.85, 1.15);
        const chunkSize = Math.max(
          this.config.minChunkSizeUsd,
          baseChunkSize * variation
        );

        chunks.push({
          index: i,
          totalChunks: numChunks,
          inputAmount: Math.min(chunkSize, remaining),
        });

        remaining -= chunkSize;
        if (remaining < this.config.minChunkSizeUsd) {
          // Merge remaining into current chunk
          chunks[chunks.length - 1].inputAmount += remaining;
          break;
        }
      }
    }

    logger.info(
      `Split ${formatUsd(totalAmountUsd)} into ${chunks.length} chunks: ` +
      chunks.map((c) => formatUsd(c.inputAmount)).join(', ')
    );

    return chunks;
  }

  /**
   * Execute a chunked trade with delays between chunks.
   */
  async executeChunkedTrade(
    chunks: TradeChunk[],
    exchange: IExchangeAdapter,
    inputToken: Token,
    outputToken: Token,
    slippageBps: number,
    onChunkComplete?: (chunk: TradeChunk, quote: SwapQuote) => void
  ): Promise<SwapQuote[]> {
    const quotes: SwapQuote[] = [];

    for (const chunk of chunks) {
      // Get quote for this chunk
      const quote = await exchange.getQuote(
        inputToken,
        outputToken,
        chunk.inputAmount,
        slippageBps
      );

      chunk.quote = quote;
      quotes.push(quote);

      if (onChunkComplete) {
        onChunkComplete(chunk, quote);
      }

      // Delay between chunks (not on the last one)
      if (chunk.index < chunk.totalChunks - 1) {
        const delay = randomBetween(
          this.config.chunkDelaySeconds[0],
          this.config.chunkDelaySeconds[1]
        );
        logger.debug(`Chunk ${chunk.index + 1}/${chunk.totalChunks} done, waiting ${delay.toFixed(1)}s`);
        await sleepSeconds(delay);
      }
    }

    return quotes;
  }

  /**
   * Evaluate if a quote is acceptable based on slippage and price impact.
   */
  evaluateQuote(
    quote: SwapQuote,
    maxSlippageBps: number,
    maxPriceImpact: number,
    isStablePair: boolean
  ): { acceptable: boolean; reason?: string } {
    // For stable pairs, be extra strict about slippage
    const effectiveMaxSlippage = isStablePair
      ? Math.min(maxSlippageBps, 30) // Max 30 bps for stablecoins
      : maxSlippageBps;

    // Calculate actual slippage in bps
    const actualSlippageBps =
      ((quote.inputAmount - quote.expectedOutputAmount) / quote.inputAmount) * 10000;

    // For stable pairs, account for the fact that 1:1 is expected
    const effectiveSlippage = isStablePair
      ? Math.abs(actualSlippageBps) // Deviation from 1:1
      : actualSlippageBps;

    if (effectiveSlippage > effectiveMaxSlippage) {
      return {
        acceptable: false,
        reason: `Slippage too high: ${effectiveSlippage.toFixed(1)} bps (max ${effectiveMaxSlippage})`,
      };
    }

    if (quote.priceImpactPercent > maxPriceImpact) {
      return {
        acceptable: false,
        reason: `Price impact too high: ${quote.priceImpactPercent.toFixed(2)}% (max ${maxPriceImpact}%)`,
      };
    }

    return { acceptable: true };
  }

  /**
   * Find the best exchange for a trade by comparing quotes.
   */
  async findBestQuote(
    exchanges: IExchangeAdapter[],
    inputToken: Token,
    outputToken: Token,
    inputAmount: number,
    slippageBps: number
  ): Promise<{ exchange: IExchangeAdapter; quote: SwapQuote } | null> {
    const results = await Promise.allSettled(
      exchanges.map(async (ex) => ({
        exchange: ex,
        quote: await ex.getQuote(inputToken, outputToken, inputAmount, slippageBps),
      }))
    );

    let best: { exchange: IExchangeAdapter; quote: SwapQuote } | null = null;

    for (const result of results) {
      if (result.status === 'fulfilled') {
        const { exchange, quote } = result.value;
        if (!best || quote.expectedOutputAmount > best.quote.expectedOutputAmount) {
          best = { exchange, quote };
        }
      }
    }

    if (best) {
      logger.debug(
        `Best quote from ${best.exchange.name}: ${best.quote.expectedOutputAmount} ${outputToken.symbol}`
      );
    }

    return best;
  }
}
