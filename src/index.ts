// ============================================
// FarmVolume — CLI & Main Entry Point
// ============================================

import { Command } from 'commander';
import { loadConfig } from './config';
import { TitanExchangeAdapter } from './exchanges/titan';
import { JupiterExchangeAdapter } from './exchanges/jupiter';
import { VolumeEngine } from './engine/volume-engine';
import { DashboardServer } from './dashboard/server';
import { TradeTracker } from './analytics/tracker';
import { AnalyticsReporter } from './analytics/reporter';
import { PAIRS, getDistractionPairs } from './utils/tokens';
import { logger } from './utils/logger';
import { Keypair } from '@solana/web3.js';
import { CAUTIOUS_PROFILE, ACTIVE_PROFILE, AGGRESSIVE_PROFILE, BOT_PROFILE } from './engine/human-behavior';

const program = new Command();
const appConfig = loadConfig();

program
  .name('farmvolume')
  .description('DEX Volume Generation Engine with Human-Like Behavior Simulation')
  .version('1.0.0');

// Command: Run Volume Generation
program
  .command('start')
  .description('Start volume generation on a chosen pair')
  .option('-p, --pair <pair>', 'Trading pair (e.g. USDC_USDT, SOL_USDC)', 'USDC_USDT')
  .option('-e, --exchange <exchange>', 'Exchange adapter (titan, jupiter)', 'titan')
  .option('-f, --funds <usd>', 'Allocated capital in USD', '100')
  .option('--min-size <usd>', 'Minimum trade size in USD', '10')
  .option('--max-size <usd>', 'Maximum trade size in USD', '50')
  .option('-t, --target <usd>', 'Target volume in USD (0 = unlimited)', '1000')
  .option('--profile <profile>', 'Behavior profile (cautious, active, aggressive, bot)', 'active')
  .option('--no-dashboard', 'Disable live web dashboard')
  .action(async (opts) => {
    try {
      const selectedPair = PAIRS[opts.pair.toUpperCase()];
      if (!selectedPair) {
        logger.error(`Unknown pair "${opts.pair}". Available: ${Object.keys(PAIRS).join(', ')}`);
        process.exit(1);
      }

      // Select behavior profile
      let behaviorProfile = ACTIVE_PROFILE;
      if (opts.profile === 'cautious') behaviorProfile = CAUTIOUS_PROFILE;
      if (opts.profile === 'aggressive') behaviorProfile = AGGRESSIVE_PROFILE;
      if (opts.profile === 'bot') behaviorProfile = BOT_PROFILE;

      behaviorProfile.distractionPairs = getDistractionPairs(selectedPair.id);

      // Session config
      const sessionConfig = {
        ...appConfig.defaultSessionConfig,
        primaryPair: selectedPair,
        exchange: opts.exchange,
        allocatedFundsUsd: parseFloat(opts.funds),
        tradeSizeRange: [parseFloat(opts.minSize), parseFloat(opts.maxSize)] as [number, number],
        targetVolumeUsd: parseFloat(opts.target),
        humanBehavior: behaviorProfile,
      };

      // Wallet
      const wallet = appConfig.solanaKeypair || Keypair.generate();
      if (!appConfig.solanaKeypair) {
        logger.warn('No SOLANA_PRIVATE_KEY provided in .env — running with mock/generated keypair');
      }

      // Initialize exchange adapter
      let adapter;
      if (opts.exchange === 'jupiter') {
        adapter = new JupiterExchangeAdapter({
          apiUrl: appConfig.jupiterApiUrl,
          rpcUrl: appConfig.solanaRpcUrl,
          wallet,
        });
      } else {
        adapter = new TitanExchangeAdapter({
          apiEndpoint: appConfig.titanApiEndpoint,
          authToken: appConfig.titanAuthToken,
          rpcUrl: appConfig.solanaRpcUrl,
          wallet,
        });
      }

      const tracker = new TradeTracker();
      const engine = new VolumeEngine(adapter, sessionConfig);

      // Launch Dashboard
      if (opts.dashboard && appConfig.dashboardEnabled) {
        const dashboard = new DashboardServer(appConfig.dashboardPort, tracker);
        dashboard.setEngine(engine);
        await dashboard.start();
      }

      // Handle termination signals
      process.on('SIGINT', () => {
        logger.warn('\nReceived SIGINT. Safely halting volume engine...');
        engine.stop();
      });

      // Start engine
      await engine.start();
    } catch (err) {
      logger.error(`Failed to start: ${(err as Error).message}`);
    }
  });

// Command: View Analytics Report
program
  .command('report')
  .description('Print analytics summary for sessions')
  .option('-s, --session <id>', 'Session ID (optional)')
  .action((opts) => {
    const tracker = new TradeTracker();
    const reporter = new AnalyticsReporter(tracker);
    const sessions = tracker.listSessions();

    if (sessions.length === 0) {
      logger.info('No recorded sessions found in database.');
      return;
    }

    const targetSession = opts.session || sessions[0].id;
    reporter.printReport(targetSession);
  });

// Command: Start Standalone Dashboard
program
  .command('dashboard')
  .description('Start the analytics web dashboard server')
  .option('-p, --port <port>', 'Dashboard port', '3847')
  .action(async (opts) => {
    const dashboard = new DashboardServer(parseInt(opts.port, 10));
    await dashboard.start();
  });

program.parse(process.argv);

