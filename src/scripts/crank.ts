/**
 This will probably move to its own repo at some point but easier to keep it here for now
 */
import * as os from 'os';
import * as fs from 'fs';
import markets from '../markets.json';
import {
  Keypair,
  Commitment,
  Connection,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { getMultipleAccounts, sleep } from '../utils/utils';
import BN from 'bn.js';
import {
  decodeEventQueue,
  DexInstructions,
  Market,
} from '@project-serum/serum';
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';

const {
  ENDPOINT_URL,
  KEYPAIR,
  PROGRAM_ID,
  INTERVAL,
  MAX_UNIQUE_ACCOUNTS,
  CONSUME_EVENTS_LIMIT,
  CLUSTER,
  HIGH_FEE_MARKETS,      // markets to apply a priority fee for
  PRIORITY_QUEUE_LIMIT,  // queue length at which to apply the priority fee
  DEFAULT_CU_PRICE,     // extra microlamports per cu for any market
  PRIORITY_CU_PRICE,     // extra microlamports per cu for high fee markets
  PRIORITY_CU_LIMIT,     // compute limit
} = process.env;

const cluster = CLUSTER || 'mainnet';
const interval = INTERVAL || 1000;
const maxUniqueAccounts = parseInt(MAX_UNIQUE_ACCOUNTS || '10');
const consumeEventsLimit = new BN(CONSUME_EVENTS_LIMIT || '30');
const priorityMarkets: number[] = JSON.parse(HIGH_FEE_MARKETS || "[0,1]");
const priorityQueueLimit = parseInt(PRIORITY_QUEUE_LIMIT || "100");
const defaultPriorityCuPrice = parseInt(DEFAULT_CU_PRICE || "0");
const priorityCuPrice = parseInt(PRIORITY_CU_PRICE || "100000");
const CuLimit = parseInt(PRIORITY_CU_LIMIT || "35000");
const serumProgramId = new PublicKey(
  PROGRAM_ID || cluster == 'mainnet'
    ? 'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX'
    : 'EoTcMgcDRTJVZDMZWBoU6rhYHZfkNTVEAfz3uUJRcYGj',
);
const walletFile = KEYPAIR || os.homedir() + '/.config/solana/devnet.json';
const payer = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(
        fs.readFileSync(walletFile, 'utf-8'),
    ),
  ),
);

console.log('openbook-cranker', payer.publicKey.toString());

const connection = new Connection(ENDPOINT_URL!, 'processed' as Commitment);

async function run() {
  const spotMarkets = await Promise.all(
    markets[cluster].map((m) => {
      return Market.load(
        connection,
        new PublicKey(m.address),
        {
          skipPreflight: true,
          commitment: 'processed' as Commitment,
        },
        serumProgramId,
      );
    }),
  );

  const quoteToken = new Token(
    connection,
    spotMarkets[0].quoteMintAddress,
    TOKEN_PROGRAM_ID,
    payer,
  );
  const quoteWallet = await quoteToken
    .getOrCreateAssociatedAccountInfo(payer.publicKey)
    .then((a) => a.address);

  const baseWallets = await Promise.all(
    spotMarkets.map((m) => {
      const token = new Token(
        connection,
        m.baseMintAddress,
        TOKEN_PROGRAM_ID,
        payer,
      );

      return token
        .getOrCreateAssociatedAccountInfo(payer.publicKey)
        .then((a) => a.address);
    }),
  );

  const eventQueuePks = spotMarkets.map(
    (market) => market['_decoded'].eventQueue,
  );

  // noinspection InfiniteLoopJS
  while (true) {
    try {
      const eventQueueAccts = await getMultipleAccounts(
        connection,
        eventQueuePks,
      );

      for (let i = 0; i < eventQueueAccts.length; i++) {
        const accountInfo = eventQueueAccts[i].accountInfo;
        const events = decodeEventQueue(accountInfo.data);

        if (events.length === 0) {
          continue;
        }

        const accounts: Set<string> = new Set();
        for (const event of events) {
          accounts.add(event.openOrders.toBase58());

          // Limit unique accounts to first 10
          if (accounts.size >= maxUniqueAccounts) {
            break;
          }
        }

        const openOrdersAccounts = [...accounts]
          .map((s) => new PublicKey(s))
          .sort((a, b) => a.toBuffer().swap64().compare(b.toBuffer().swap64()));

        const instr = DexInstructions.consumeEvents({
          market: spotMarkets[i].publicKey,
          eventQueue: spotMarkets[i]['_decoded'].eventQueue,
          coinFee: baseWallets[i],
          pcFee: quoteWallet,
          openOrdersAccounts,
          limit: consumeEventsLimit,
          programId: serumProgramId,
        });
        const transaction = new Transaction();
        transaction.add(
          ComputeBudgetProgram.setComputeUnitLimit({
            units: CuLimit,
          })
        );
        if (events.length > priorityQueueLimit) {
          const isHighFeeMarket = priorityMarkets.includes(i);
          transaction.add(
            ComputeBudgetProgram.setComputeUnitPrice({
              microLamports: isHighFeeMarket ? priorityCuPrice : defaultPriorityCuPrice,
            })
          );
        }
        transaction.add(instr);

        console.log(
          'market',
          i,
          'sending consume events for',
          events.length,
          'events',
        );
        console.log(await connection.sendTransaction(transaction, [payer], {
          skipPreflight: true,
          maxRetries: 2,
        }));
      }
      await sleep(interval);
    } catch (e) {
      console.error(e);
    }
  }
}

run();