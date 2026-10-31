// ============================================
// FarmVolume — Configuration Loader
// ============================================

import dotenv from 'dotenv';
import path from 'path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { SessionConfig, RiskConfig, HumanBehaviorConfig, OptimizerConfig } from '../types';
import { PAIRS, getDistractionPairs } from '../utils/tokens';
import { ACTIVE_PROFILE } from '../engine/human-behavior';
import { generateSessionId } from '../utils/helpers';

dotenv.config({ path: path.join(process.cwd(), '.env') });

export interface AppConfig {
  solanaRpcUrl: string;
  solanaKeypair: Keypair | null;
  titanApiEndpoint: string;
  titanAuthToken: string;
  jupiterApiUrl: string;
  dashboardPort: number;
  dashboardEnabled: boolean;
  defaultSessionConfig: SessionConfig;
}

export function loadConfig(): AppConfig {
  const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const privateKeyStr = process.env.SOLANA_PRIVATE_KEY || '';

  let keypair: Keypair | null = null;
  if (privateKeyStr && privateKeyStr !== 'your_base58_private_key_here') {
    try {
      const secret = bs58.decode(privateKeyStr);
      keypair = Keypair.fromSecretKey(secret);
    } catch (e) {
      console.warn('⚠️ Could not decode SOLANA_PRIVATE_KEY from .env');
    }
  }

  const riskConfig: RiskConfig = {
    maxTotalLossUsd: parseFloat(process.env.MAX_LOSS_USD || '10.0'),
    maxTotalLossPercent: parseFloat(process.env.MAX_LOSS_PERCENT || '2.0'),
    maxPerTradeLossUsd: parseFloat(process.env.MAX_PER_TRADE_LOSS_USD || '0.50'),
    maxSlippageBps: parseInt(process.env.DEFAULT_SLIPPAGE_BPS || '30', 10),
    maxPriceImpactPercent: 0.15, // 0.15% max price impact for stables
    minSolBalance: 0.015, // Require at least 0.015 SOL for gas
    dailyLossCapUsd: 15.0,
    failedTradeCooldownSeconds: 15,
    maxConsecutiveFailures: 3,
  };

  const humanBehavior: HumanBehaviorConfig = {
    ...ACTIVE_PROFILE,
    minDelaySeconds: parseInt(process.env.MIN_DELAY_BETWEEN_TRADES || '8', 10),
    maxDelaySeconds: parseInt(process.env.MAX_DELAY_BETWEEN_TRADES || '40', 10),
    sessionActiveMinutesMin: parseInt(process.env.SESSION_ACTIVE_MINUTES_MIN || '8', 10),
    sessionActiveMinutesMax: parseInt(process.env.SESSION_ACTIVE_MINUTES_MAX || '25', 10),
    sessionBreakMinutesMin: parseInt(process.env.SESSION_BREAK_MINUTES_MIN || '3', 10),
    sessionBreakMinutesMax: parseInt(process.env.SESSION_BREAK_MINUTES_MAX || '12', 10),
    distractionPairs: getDistractionPairs('USDC_USDT'),
  };

  const optimizer: OptimizerConfig = {
    splitThresholdUsd: 250, // Split trades larger than $250
    maxChunks: 4,
    minChunkSizeUsd: 50,
    chunkDelaySeconds: [2, 6],
    crossExchangeRouting: true,
    priorityFeeLamports: 10000,
    computeUnitLimit: 200000,
  };

  const defaultSessionConfig: SessionConfig = {
    id: generateSessionId(),
    primaryPair: PAIRS.USDC_USDT,
    exchange: process.env.DEFAULT_EXCHANGE || 'titan',
    allocatedFundsUsd: 100,
    tradeSizeRange: [
      parseFloat(process.env.TRADE_SIZE_MIN_USD || '10'),
      parseFloat(process.env.TRADE_SIZE_MAX_USD || '50'),
    ],
    targetVolumeUsd: 5000,
    maxDurationMinutes: 0,
    maxCycles: 0,
    humanBehavior,
    risk: riskConfig,
    optimizer,
  };

  return {
    solanaRpcUrl: rpcUrl,
    solanaKeypair: keypair,
    titanApiEndpoint: process.env.TITAN_API_ENDPOINT || 'https://portal.api.titan.exchange',
    titanAuthToken: process.env.TITAN_AUTH_TOKEN || '',
    jupiterApiUrl: process.env.JUPITER_API_URL || 'https://api.jup.ag/swap/v1',
    dashboardPort: parseInt(process.env.DASHBOARD_PORT || '3847', 10),
    dashboardEnabled: process.env.DASHBOARD_ENABLED !== 'false',
    defaultSessionConfig,
  };
}

