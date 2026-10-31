// ============================================
// FarmVolume — Single Safe Test Swap Script
// ============================================

import { loadConfig } from './config';
import { TitanExchangeAdapter } from './exchanges/titan';
import { JupiterExchangeAdapter } from './exchanges/jupiter';
import { TOKENS } from './utils/tokens';
import { logger } from './utils/logger';
import { formatUsd } from './utils/helpers';
import { Command } from 'commander';

const program = new Command();

program
  .name('test-swap')
  .description('Test your wallet and Titan Exchange connectivity with a single micro-swap')
  .option('-a, --amount <number>', 'Amount of token to test swap', '1.0')
  .option('-e, --execute', 'Actually execute the swap on chain (otherwise dry-run only)', false)
  .action(async (opts) => {
    try {
      logger.banner();
      logger.info('🔍 Initializing Single Test Swap...');
      logger.divider();

      const config = loadConfig();

      if (!config.solanaKeypair) {
        logger.error('❌ No valid SOLANA_PRIVATE_KEY found in .env!');
        logger.info('Please open .env and add your base58 wallet private key.');
        process.exit(1);
      }

      const wallet = config.solanaKeypair;
      const pubkey = wallet.publicKey.toBase58();
      logger.info(`🔑 Wallet Address: ${pubkey}`);

      // Initialize Titan adapter
      const adapter = new TitanExchangeAdapter({
        apiEndpoint: config.titanApiEndpoint,
        authToken: config.titanAuthToken,
        rpcUrl: config.solanaRpcUrl,
        wallet,
      });

      await adapter.connect();

      // Check Balances
      logger.info('Checking wallet token balances...');
      const solBalance = await adapter.getBalance(TOKENS.SOL);
      const usdcBalance = await adapter.getBalance(TOKENS.USDC);
      const usdtBalance = await adapter.getBalance(TOKENS.USDT);

      logger.info(`   SOL Balance:  ${solBalance.toFixed(4)} SOL`);
      logger.info(`   USDC Balance: ${usdcBalance.toFixed(4)} USDC`);
      logger.info(`   USDT Balance: ${usdtBalance.toFixed(4)} USDT`);
      logger.divider();

      if (solBalance < 0.005) {
        logger.warn('⚠️ SOL balance is very low (< 0.005 SOL). You need a little SOL for Solana transaction fees.');
      }

      const testAmount = parseFloat(opts.amount);

      // Determine swap direction based on balances
      let inputToken = TOKENS.USDC;
      let outputToken = TOKENS.USDT;

      if (usdcBalance < testAmount && usdtBalance >= testAmount) {
        inputToken = TOKENS.USDT;
        outputToken = TOKENS.USDC;
      }

      const inputBalance = inputToken.symbol === 'USDC' ? usdcBalance : usdtBalance;

      if (inputBalance < testAmount) {
        logger.error(
          `❌ Insufficient ${inputToken.symbol} balance! You have ${inputBalance.toFixed(2)} ${inputToken.symbol}, but test swap requires ${testAmount} ${inputToken.symbol}.`
        );
        logger.info(`Please fund your wallet (${pubkey}) with at least $${testAmount} USDC or USDT.`);
        process.exit(1);
      }

      logger.info(`Fetching live quote from Titan for ${testAmount} ${inputToken.symbol} → ${outputToken.symbol}...`);

      const quote = await adapter.getQuote(inputToken, outputToken, testAmount, 30); // 30 bps = 0.3% max slippage

      logger.success('✅ Live quote received from Titan!');
      logger.info(`   Input:           ${quote.inputAmount} ${inputToken.symbol}`);
      logger.info(`   Expected Output: ${quote.expectedOutputAmount.toFixed(4)} ${outputToken.symbol}`);
      logger.info(`   Min Output:      ${quote.minimumOutputAmount.toFixed(4)} ${outputToken.symbol}`);
      logger.info(`   Price Impact:    ${quote.priceImpactPercent.toFixed(4)}%`);
      logger.info(`   Route:           ${quote.route}`);
      logger.divider();

      if (!opts.execute) {
        logger.warn('⚠️ DRY-RUN MODE: The swap was NOT broadcast to the blockchain.');
        logger.info('To actually execute this real test swap, run:');
        logger.info(`npm run test:swap -- --amount ${testAmount} --execute`);
        return;
      }

      logger.info('🚀 Executing swap on Solana blockchain...');
      const result = await adapter.executeSwap(quote);

      if (result.success) {
        logger.success('🎉 SWAP COMPLETED SUCCESSFULLY!');
        logger.info(`   Transaction Signature: ${result.txSignature}`);
        logger.info(`   Solscan Explorer:      https://solscan.io/tx/${result.txSignature}`);
        logger.info(`   Output Received:       ${result.outputAmount} ${outputToken.symbol}`);

        // Re-check balances
        const newUsdc = await adapter.getBalance(TOKENS.USDC);
        const newUsdt = await adapter.getBalance(TOKENS.USDT);
        logger.info(`   Updated USDC: ${newUsdc.toFixed(4)}`);
        logger.info(`   Updated USDT: ${newUsdt.toFixed(4)}`);
      } else {
        logger.error(`❌ Swap failed: ${result.error}`);
      }
    } catch (err) {
      logger.error(`Test error: ${(err as Error).message}`);
    }
  });

program.parse(process.argv);

