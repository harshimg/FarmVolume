// ============================================
// FarmVolume — Solana Token Registry
// ============================================

import { Token, TokenPair } from '../types';

/** Well-known Solana token mint addresses */
export const TOKENS: Record<string, Token> = {
  SOL: {
    symbol: 'SOL',
    name: 'Solana',
    mint: 'So11111111111111111111111111111111111111112',
    decimals: 9,
  },
  USDC: {
    symbol: 'USDC',
    name: 'USD Coin',
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    decimals: 6,
  },
  USDT: {
    symbol: 'USDT',
    name: 'Tether USD',
    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    decimals: 6,
  },
  BONK: {
    symbol: 'BONK',
    name: 'Bonk',
    mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    decimals: 5,
  },
  JUP: {
    symbol: 'JUP',
    name: 'Jupiter',
    mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    decimals: 6,
  },
  RAY: {
    symbol: 'RAY',
    name: 'Raydium',
    mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
    decimals: 6,
  },
  PYTH: {
    symbol: 'PYTH',
    name: 'Pyth Network',
    mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
    decimals: 6,
  },
  WIF: {
    symbol: 'WIF',
    name: 'dogwifhat',
    mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    decimals: 6,
  },
  ORCA: {
    symbol: 'ORCA',
    name: 'Orca',
    mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',
    decimals: 6,
  },
  MSOL: {
    symbol: 'mSOL',
    name: 'Marinade Staked SOL',
    mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
    decimals: 9,
  },
  JITOSOL: {
    symbol: 'JitoSOL',
    name: 'Jito Staked SOL',
    mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
    decimals: 9,
  },
};

/** Pre-defined common trading pairs */
export const PAIRS: Record<string, TokenPair> = {
  USDC_USDT: {
    id: 'USDC_USDT',
    tokenA: TOKENS.USDC,
    tokenB: TOKENS.USDT,
    isStablePair: true,
  },
  SOL_USDC: {
    id: 'SOL_USDC',
    tokenA: TOKENS.SOL,
    tokenB: TOKENS.USDC,
    isStablePair: false,
  },
  SOL_USDT: {
    id: 'SOL_USDT',
    tokenA: TOKENS.SOL,
    tokenB: TOKENS.USDT,
    isStablePair: false,
  },
  BONK_USDC: {
    id: 'BONK_USDC',
    tokenA: TOKENS.BONK,
    tokenB: TOKENS.USDC,
    isStablePair: false,
  },
  JUP_USDC: {
    id: 'JUP_USDC',
    tokenA: TOKENS.JUP,
    tokenB: TOKENS.USDC,
    isStablePair: false,
  },
  WIF_USDC: {
    id: 'WIF_USDC',
    tokenA: TOKENS.WIF,
    tokenB: TOKENS.USDC,
    isStablePair: false,
  },
  RAY_USDC: {
    id: 'RAY_USDC',
    tokenA: TOKENS.RAY,
    tokenB: TOKENS.USDC,
    isStablePair: false,
  },
  MSOL_SOL: {
    id: 'MSOL_SOL',
    tokenA: TOKENS.MSOL,
    tokenB: TOKENS.SOL,
    isStablePair: true, // Pegged ~1:1
  },
};

/**
 * Create a custom token pair
 */
export function createPair(tokenA: Token, tokenB: Token, isStable: boolean = false): TokenPair {
  return {
    id: `${tokenA.symbol}_${tokenB.symbol}`,
    tokenA,
    tokenB,
    isStablePair: isStable,
  };
}

/**
 * Create a custom token from mint address
 */
export function createToken(
  symbol: string,
  name: string,
  mint: string,
  decimals: number
): Token {
  return { symbol, name, mint, decimals };
}

/**
 * Get token by symbol
 */
export function getToken(symbol: string): Token | undefined {
  return TOKENS[symbol.toUpperCase()];
}

/**
 * Get pair by ID
 */
export function getPair(id: string): TokenPair | undefined {
  return PAIRS[id.toUpperCase()];
}

/**
 * Get all distraction pairs (excluding the given primary pair)
 */
export function getDistractionPairs(primaryPairId: string): TokenPair[] {
  return Object.values(PAIRS).filter((p) => p.id !== primaryPairId);
}

/**
 * Convert token amount from human-readable to raw (with decimals)
 */
export function toRawAmount(amount: number, decimals: number): bigint {
  return BigInt(Math.floor(amount * Math.pow(10, decimals)));
}

/**
 * Convert token amount from raw to human-readable
 */
export function fromRawAmount(rawAmount: bigint, decimals: number): number {
  return Number(rawAmount) / Math.pow(10, decimals);
}
