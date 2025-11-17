import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/web";
import { withPolkadotSdkCompat } from "polkadot-api/polkadot-sdk-compat";
import { dot } from "@polkadot-api/descriptors";
import { ah } from "@polkadot-api/descriptors";

/**
 * This script processes all accounts that:
 * - Exist in RcMigrator.RcAccounts on Relay Chain
 * - Have vesting schedules on Asset Hub
 * 
 * For each account, it calculates optimal vesting split:
 * - RC vesting covers the FULL RC balance (free + reserved)
 * - AH vesting covers the remainder
 * - Total unvesting rate (perBlock) stays the same
 * 
 * This maximizes vesting on RC and minimizes vesting on AH while maintaining
 * the same total unvesting speed.
 */

const RELAY_CHAIN_WS = "wss://rpc.polkadot.io";
const ASSET_HUB_WS = "wss://polkadot-asset-hub-rpc.polkadot.io";

const DOT = 10_000_000_000n;

// Helper function to format balance in DOT with 3 decimal places
function formatDOT(amount: bigint | number): string {
  const amt = BigInt(amount);
  const whole = amt / DOT;
  const remainder = amt % DOT;
  const decimal = (Number(remainder) / Number(DOT)).toFixed(3).substring(2);
  return `${whole}.${decimal} DOT`;
}

// Calculate unvested amount for a given block number
function calculateUnvestedAmount(vestingData: any[], blockNumber: bigint): bigint {
  let totalUnvestedAmount = 0n;
  
  if (vestingData && Array.isArray(vestingData)) {
    for (const schedule of vestingData) {
      const locked = BigInt(schedule.locked ?? 0);
      const perBlock = BigInt(schedule.per_block ?? 0);
      const startingBlock = BigInt(schedule.starting_block ?? 0);
      
      const vestedBlockCount = blockNumber > startingBlock 
        ? blockNumber - startingBlock 
        : 0n;
      
      const effectivePerBlock = perBlock > 0n ? perBlock : 1n;
      const alreadyUnlocked = vestedBlockCount * effectivePerBlock;
      
      const stillVesting = locked > alreadyUnlocked 
        ? locked - alreadyUnlocked 
        : 0n;
      
      totalUnvestedAmount += stillVesting;
    }
  }
  
  return totalUnvestedAmount;
}

interface VestingSplit {
  rcSchedules: Array<{
    locked: bigint;
    per_block: bigint;
    starting_block: number;
  }>;
  ahSchedules: Array<{
    locked: bigint;
    per_block: bigint;
    starting_block: number;
  }>;
  rcTotalLocked: bigint;
  ahTotalLocked: bigint;
  rcTotalPerBlock: bigint;
  ahTotalPerBlock: bigint;
  rcUnvested: bigint;
  ahUnvested: bigint;
}

function splitVesting(
  vestingData: any[],
  rcBalance: bigint,
  currentBlock: bigint
): VestingSplit {
  // Calculate total currently unvested amount
  const totalUnvested = calculateUnvestedAmount(vestingData, currentBlock);
  
  // Calculate split proportion: RC gets enough to cover its balance
  // If RC balance > total unvested, RC gets all vesting
  const rcUnvestedTarget = rcBalance > totalUnvested ? totalUnvested : rcBalance;
  const ahUnvestedTarget = totalUnvested - rcUnvestedTarget;
  
  const rcProportion = totalUnvested > 0n ? Number(rcUnvestedTarget) / Number(totalUnvested) : 0;
  const ahProportion = totalUnvested > 0n ? Number(ahUnvestedTarget) / Number(totalUnvested) : 0;
  
  const rcSchedules = [];
  const ahSchedules = [];
  
  let rcTotalLocked = 0n;
  let ahTotalLocked = 0n;
  let rcTotalPerBlock = 0n;
  let ahTotalPerBlock = 0n;
  
  for (const schedule of vestingData) {
    const originalLocked = BigInt(schedule.locked ?? 0);
    const originalPerBlock = BigInt(schedule.per_block ?? 0);
    const startingBlock = Number(schedule.starting_block ?? 0);
    
    // Calculate RC portion
    const rcLocked = BigInt(Math.floor(Number(originalLocked) * rcProportion));
    const rcPerBlock = BigInt(Math.floor(Number(originalPerBlock) * rcProportion));
    
    // Calculate AH portion (ensure total adds up by using remainder)
    const ahLocked = originalLocked - rcLocked;
    const ahPerBlock = originalPerBlock - rcPerBlock;
    
    if (rcLocked > 0n && rcPerBlock > 0n) {
      rcSchedules.push({
        locked: rcLocked,
        per_block: rcPerBlock,
        starting_block: startingBlock
      });
      rcTotalLocked += rcLocked;
      rcTotalPerBlock += rcPerBlock;
    }
    
    if (ahLocked > 0n && ahPerBlock > 0n) {
      ahSchedules.push({
        locked: ahLocked,
        per_block: ahPerBlock,
        starting_block: startingBlock
      });
      ahTotalLocked += ahLocked;
      ahTotalPerBlock += ahPerBlock;
    }
  }
  
  // Calculate actual unvested amounts after split
  const rcUnvested = calculateUnvestedAmount(
    rcSchedules.map(s => ({ locked: s.locked, per_block: s.per_block, starting_block: s.starting_block })),
    currentBlock
  );
  const ahUnvested = calculateUnvestedAmount(
    ahSchedules.map(s => ({ locked: s.locked, per_block: s.per_block, starting_block: s.starting_block })),
    currentBlock
  );
  
  return {
    rcSchedules,
    ahSchedules,
    rcTotalLocked,
    ahTotalLocked,
    rcTotalPerBlock,
    ahTotalPerBlock,
    rcUnvested,
    ahUnvested
  };
}

async function main() {
  // Connect to Polkadot (Relay Chain)
  const relayClient = createClient(
    withPolkadotSdkCompat(getWsProvider(RELAY_CHAIN_WS))
  );
  const relayApi = relayClient.getTypedApi(dot);

  // Connect to Asset Hub
  const assetHubClient = createClient(
    withPolkadotSdkCompat(getWsProvider(ASSET_HUB_WS))
  );
  const assetHubApi = assetHubClient.getTypedApi(ah);

  // Get current Relay Chain block number
  const currentBlock = await relayApi.query.System.Number.getValue();
  const currentBlockBigInt = BigInt(currentBlock);
  
  console.log("=".repeat(80));
  console.log("VESTING SPLIT CALCULATOR FOR ALL RC MIGRATOR ACCOUNTS");
  console.log("=".repeat(80));
  console.log(`Current Relay Chain Block: ${currentBlock}\n`);

  console.log("Fetching RcMigrator.RcAccounts entries...");
  const rcMigratorEntries = await relayApi.query.RcMigrator.RcAccounts.getEntries();
  
  const rcMigratorAccounts = new Set<string>();
  for (const entry of rcMigratorEntries) {
    const ss58 = entry.keyArgs[0];
    rcMigratorAccounts.add(ss58);
  }
  
  console.log(`Found ${rcMigratorAccounts.size} accounts in RcMigrator.RcAccounts\n`);

  console.log("Fetching Asset Hub Vesting.Vesting entries...");
  const vestingEntries = await assetHubApi.query.Vesting.Vesting.getEntries();
  
  const vestingAccounts = new Set<string>();
  for (const entry of vestingEntries) {
    const ss58 = entry.keyArgs[0];
    vestingAccounts.add(ss58);
  }
  
  console.log(`Found ${vestingAccounts.size} accounts in Asset Hub Vesting.Vesting\n`);
  
  console.log("Fetching System.Account entries...");
  const systemAccountEntries = await relayApi.query.System.Account.getEntries();
  console.log(`Found ${systemAccountEntries.length} accounts in System.Account\n`);

  let processedCount = 0;
  let totalRcVesting = 0n;
  let totalAhVesting = 0n;

  console.log("=".repeat(80));
  console.log("PROCESSING ACCOUNTS");
  console.log("=".repeat(80));
  console.log();

  for (const entry of systemAccountEntries) {
    const ss58 = entry.keyArgs[0];
    const accountData = entry.value;

    // Only process accounts in RcMigrator that have vesting
    if (!rcMigratorAccounts.has(ss58) || !vestingAccounts.has(ss58)) {
      continue;
    }

    const free = accountData.data.free;
    const reserved = accountData.data.reserved;
    const frozen = accountData.data.frozen;
    
    // Skip zero balance accounts
    if (free === 0n && reserved === 0n && frozen === 0n) {
      continue;
    }

    // Fetch vesting data from Asset Hub
    let vestingData: any[] = [];
    try {
      vestingData = await assetHubApi.query.Vesting.Vesting.getValue(ss58);
    } catch (e) {
      console.error(`Error fetching vesting data for ${ss58}: ${e}`);
      continue;
    }

    if (!vestingData || vestingData.length === 0) {
      continue;
    }

    // Calculate RC balance (free + reserved)
    const rcBalance = free + reserved;
    
    // Fetch Asset Hub account balance
    let ahFree = 0n;
    let ahReserved = 0n;
    try {
      const ahAccountData = await assetHubApi.query.System.Account.getValue(ss58);
      ahFree = ahAccountData?.data?.free ?? 0n;
      ahReserved = ahAccountData?.data?.reserved ?? 0n;
    } catch (e) {
      console.error(`Error fetching Asset Hub account data for ${ss58}: ${e}`);
    }

    // Calculate original unvested amount
    const originalUnvested = calculateUnvestedAmount(vestingData, currentBlockBigInt);
    
    // Calculate split
    const split = splitVesting(vestingData, rcBalance, currentBlockBigInt);
    
    processedCount++;
    totalRcVesting += split.rcUnvested;
    totalAhVesting += split.ahUnvested;

    // Print account details
    console.log(`Account ${processedCount}: ${ss58}`);
    console.log("-".repeat(80));
    console.log(`Relay Chain Balance: ${formatDOT(rcBalance)} (free: ${formatDOT(free)}, reserved: ${formatDOT(reserved)})`);
    console.log(`Asset Hub Balance: ${formatDOT(ahFree + ahReserved)} (free: ${formatDOT(ahFree)}, reserved: ${formatDOT(ahReserved)})`);
    console.log();
    
    const originalTotalLocked = vestingData.reduce((sum, s) => sum + BigInt(s.locked ?? 0), 0n);
    const originalTotalPerBlock = vestingData.reduce((sum, s) => sum + BigInt(s.per_block ?? 0), 0n);
    
    console.log(`Original Vesting (all on AH):`);
    console.log(`  Total unvested: ${formatDOT(originalUnvested)}`);
    console.log(`  Total locked: ${formatDOT(originalTotalLocked)}`);
    console.log(`  Total per block: ${formatDOT(originalTotalPerBlock)}`);
    console.log(`  Schedules: ${vestingData.length}`);
    vestingData.forEach((schedule, idx) => {
      console.log(`    [${idx + 1}] locked: ${BigInt(schedule.locked ?? 0).toString().padStart(20)} | per_block: ${BigInt(schedule.per_block ?? 0).toString().padStart(10)} | starting_block: ${schedule.starting_block ?? 0}`);
    });
    console.log();
    
    console.log(`Split Vesting:`);
    console.log(`  RC unvested: ${formatDOT(split.rcUnvested)} (${split.rcUnvested >= rcBalance ? '✓ covers RC balance' : '⚠️  does not cover RC balance'})`);
    console.log(`  AH unvested: ${formatDOT(split.ahUnvested)}`);
    console.log(`  Total unvested: ${formatDOT(split.rcUnvested + split.ahUnvested)}`);
    console.log();
    
    if (split.rcSchedules.length > 0) {
      console.log(`  RELAY CHAIN VESTING (${split.rcSchedules.length} schedules):`);
      split.rcSchedules.forEach((schedule, idx) => {
        console.log(`    [${idx + 1}] locked: ${schedule.locked.toString().padStart(20)} | per_block: ${schedule.per_block.toString().padStart(10)} | starting_block: ${schedule.starting_block}`);
      });
      console.log(`    Total: locked=${split.rcTotalLocked.toString()}, per_block=${split.rcTotalPerBlock.toString()}`);
      console.log();
    }
    
    if (split.ahSchedules.length > 0) {
      console.log(`  ASSET HUB VESTING (${split.ahSchedules.length} schedules):`);
      split.ahSchedules.forEach((schedule, idx) => {
        console.log(`    [${idx + 1}] locked: ${schedule.locked.toString().padStart(20)} | per_block: ${schedule.per_block.toString().padStart(10)} | starting_block: ${schedule.starting_block}`);
      });
      console.log(`    Total: locked=${split.ahTotalLocked.toString()}, per_block=${split.ahTotalPerBlock.toString()}`);
      console.log();
    }
    
    // Verification
    const splitTotalPerBlock = split.rcTotalPerBlock + split.ahTotalPerBlock;
    const perBlockMatch = originalTotalPerBlock === splitTotalPerBlock;
    
    console.log(`  Verification:`);
    console.log(`    Original per_block: ${originalTotalPerBlock.toString()}`);
    console.log(`    Split per_block: ${splitTotalPerBlock.toString()}`);
    console.log(`    Match: ${perBlockMatch ? '✓' : '✗ MISMATCH'}`);
    console.log();
    console.log("=".repeat(80));
    console.log();
  }

  // Print summary
  console.log("\n" + "=".repeat(80));
  console.log("SUMMARY");
  console.log("=".repeat(80));
  console.log(`Total accounts processed: ${processedCount}`);
  console.log(`Total RC vesting (current unvested): ${formatDOT(totalRcVesting)}`);
  console.log(`Total AH vesting (current unvested): ${formatDOT(totalAhVesting)}`);
  console.log(`Total combined vesting: ${formatDOT(totalRcVesting + totalAhVesting)}`);
  console.log("=".repeat(80));

  // Properly terminate process
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

