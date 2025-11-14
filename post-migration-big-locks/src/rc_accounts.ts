import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/web";
import { withPolkadotSdkCompat } from "polkadot-api/polkadot-sdk-compat";
import { dot } from "@polkadot-api/descriptors";
import { ah } from "@polkadot-api/descriptors";

/**
 * This script analyzes accounts in Relay Chain System.Account and prints:
 * 1. Accounts that do NOT exist in RcMigrator.RcAccounts but DO have vesting on Asset Hub
 * 2. Accounts that DO exist in RcMigrator.RcAccounts AND have vesting on Asset Hub
 * 
 * For accounts in category 2, it calculates "missing vesting" at multiple time periods:
 * - Now, +6 months, +1 year, +1 year 2 months, +1 year 6 months
 * - For each time period:
 *   - Iterates through all vesting schedules on Asset Hub for the account
 *   - Calculates how much will still be vesting (locked but not yet unlocked)
 *   - Compares total unvested amount with the account's actual balance on Asset Hub
 *   - If unvested amount > (free + reserved) on Asset Hub, the difference is "missing vesting"
 *     (tokens that should be vesting on Asset Hub but aren't there)
 * 
 * Note: 1 block = 6 seconds
 */


const RELAY_CHAIN_WS = "wss://rpc.polkadot.io";
const ASSET_HUB_WS = "wss://polkadot-asset-hub-rpc.polkadot.io";

const DOT = 10_000_000_000n;

// Block time constants (1 block = 6 seconds)
const BLOCKS_PER_DAY = 14_400n; // (24 * 60 * 60) / 6 = 14,400 blocks/day
const BLOCKS_PER_MONTH = 432_000n; // 30 days * 14,400
const BLOCKS_6_MONTHS = 2_592_000n; // 180 days * 14,400
const BLOCKS_1_YEAR = 5_256_000n; // 365 days * 14,400
const BLOCKS_1_YEAR_2_MONTHS = 5_688_000n; // (365 + 60) days * 14,400
const BLOCKS_1_YEAR_6_MONTHS = 7_848_000n; // (365 + 180) days * 14,400

// Helper function to format balance in DOT with 3 decimal places
function formatDOT(amount: bigint | number): string {
  const amt = BigInt(amount);
  const whole = amt / DOT;
  const remainder = amt % DOT;
  const decimal = (Number(remainder) / Number(DOT)).toFixed(3).substring(2); // Get 3 decimals
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
      
      // Calculate how many blocks have passed since vesting started
      const vestedBlockCount = blockNumber > startingBlock 
        ? blockNumber - startingBlock 
        : 0n;
      
      // Calculate already unlocked amount (at least 1 per block, matching max(One::one()))
      const effectivePerBlock = perBlock > 0n ? perBlock : 1n;
      const alreadyUnlocked = vestedBlockCount * effectivePerBlock;
      
      // Calculate still vesting amount (cannot be negative)
      const stillVesting = locked > alreadyUnlocked 
        ? locked - alreadyUnlocked 
        : 0n;
      
      totalUnvestedAmount += stillVesting;
    }
  }
  
  return totalUnvestedAmount;
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

  // Get current Relay Chain block number for vesting calculations
  const currentBlock = await relayApi.query.System.Number.getValue();
  console.log(`Current Relay Chain Block: ${currentBlock}\n`);

  console.log("Fetching RcMigrator.RcAccounts entries...");
  const rcMigratorEntries = await relayApi.query.RcMigrator.RcAccounts.getEntries();
  
  // Build a Set of accounts that exist in RcMigrator.RcAccounts for fast lookup
  const rcMigratorAccounts = new Set<string>();
  for (const entry of rcMigratorEntries) {
    const ss58 = entry.keyArgs[0];
    rcMigratorAccounts.add(ss58);
  }
  
  console.log(`Found ${rcMigratorAccounts.size} accounts in RcMigrator.RcAccounts\n`);

  console.log("Fetching Asset Hub Vesting.Vesting entries...");
  const vestingEntries = await assetHubApi.query.Vesting.Vesting.getEntries();
  
  // Build a Set of accounts that have vesting on Asset Hub
  const vestingAccounts = new Set<string>();
  for (const entry of vestingEntries) {
    const ss58 = entry.keyArgs[0];
    vestingAccounts.add(ss58);
  }
  
  console.log(`Found ${vestingAccounts.size} accounts in Asset Hub Vesting.Vesting\n`);
  
  console.log("Fetching System.Account entries...");
  const systemAccountEntries = await relayApi.query.System.Account.getEntries();
  console.log(`Found ${systemAccountEntries.length} accounts in System.Account\n`);

  // Stats tracking
  let totalSystemAccounts = 0;
  let accountsNotInRcMigrator = 0;
  let totalFreeBalance = 0n;
  let totalReservedBalance = 0n;
  
  let accountsInRcMigratorWithVesting = 0;
  let totalFreeBalanceInRcMigrator = 0n;
  let totalReservedBalanceInRcMigrator = 0n;
  let accountsWithMissingVesting = 0;
  let totalMissingVesting = 0n;

  console.log("Accounts in System.Account but NOT in RcMigrator.RcAccounts that HAVE Vesting on Asset Hub:");
  console.log("=".repeat(80));

  for (const entry of systemAccountEntries) {
    totalSystemAccounts++;
    const ss58 = entry.keyArgs[0];
    const accountData = entry.value;

    // Check if account exists in RcMigrator.RcAccounts
    if (!rcMigratorAccounts.has(ss58)) {
      const free = accountData.data.free;
      const reserved = accountData.data.reserved;
      const frozen = accountData.data.frozen;
      
      // Skip accounts with zero balances (no free, no reserved, no frozen)
      if (free === 0n && reserved === 0n && frozen === 0n) {
        continue;
      }

      // Only include accounts that have vesting on Asset Hub
      if (!vestingAccounts.has(ss58)) {
        continue;
      }

      accountsNotInRcMigrator++;
      
      totalFreeBalance += free;
      totalReservedBalance += reserved;

      console.log(`Account: ${ss58}`);
      console.log(`  nonce: ${accountData.nonce}`);
      console.log(`  consumers: ${accountData.consumers}`);
      console.log(`  providers: ${accountData.providers}`);
      console.log(`  sufficients: ${accountData.sufficients}`);
      console.log(`  free: ${formatDOT(free)}`);
      console.log(`  reserved: ${formatDOT(reserved)}`);
      console.log(`  frozen: ${formatDOT(frozen)}`);
      console.log("-".repeat(80));
    }
  }

  console.log("\n");
  console.log("Accounts that ARE in RcMigrator.RcAccounts AND HAVE Vesting on Asset Hub:");
  console.log("=".repeat(80));

  for (const entry of systemAccountEntries) {
    const ss58 = entry.keyArgs[0];
    const accountData = entry.value;

    // Check if account exists in RcMigrator.RcAccounts AND has vesting
    if (rcMigratorAccounts.has(ss58) && vestingAccounts.has(ss58)) {
      const free = accountData.data.free;
      const reserved = accountData.data.reserved;
      const frozen = accountData.data.frozen;
      
      // Skip accounts with zero balances (no free, no reserved, no frozen)
      if (free === 0n && reserved === 0n && frozen === 0n) {
        continue;
      }

      // Fetch vesting data and calculate unvested amounts for different time periods
      let vestingData: any[] = [];
      try {
        vestingData = await assetHubApi.query.Vesting.Vesting.getValue(ss58);
      } catch (e) {
        console.error(`    Error fetching vesting data: ${e}`);
      }

      accountsInRcMigratorWithVesting++;
      
      totalFreeBalanceInRcMigrator += free;
      totalReservedBalanceInRcMigrator += reserved;

      // Fetch Asset Hub account balance
      let ahFree = 0n;
      let ahReserved = 0n;
      let ahFrozen = 0n;
      try {
        const ahAccountData = await assetHubApi.query.System.Account.getValue(ss58);
        ahFree = ahAccountData?.data?.free ?? 0n;
        ahReserved = ahAccountData?.data?.reserved ?? 0n;
        ahFrozen = ahAccountData?.data?.frozen ?? 0n;
      } catch (e) {
        console.error(`    Error fetching Asset Hub account data: ${e}`);
      }

      const currentBlockBigInt = BigInt(currentBlock);
      const ahAvailableBalance = ahFree + ahReserved;
      
      // Calculate unvested amounts at different future blocks
      const unvestedNow = calculateUnvestedAmount(vestingData, currentBlockBigInt);
      const unvested6Months = calculateUnvestedAmount(vestingData, currentBlockBigInt + BLOCKS_6_MONTHS);
      const unvested1Year = calculateUnvestedAmount(vestingData, currentBlockBigInt + BLOCKS_1_YEAR);
      const unvested1Year2Months = calculateUnvestedAmount(vestingData, currentBlockBigInt + BLOCKS_1_YEAR_2_MONTHS);
      const unvested1Year6Months = calculateUnvestedAmount(vestingData, currentBlockBigInt + BLOCKS_1_YEAR_6_MONTHS);
      
      // Calculate missing vesting at different time periods
      const missingNow = unvestedNow > ahAvailableBalance ? unvestedNow - ahAvailableBalance : 0n;
      const missing6Months = unvested6Months > ahAvailableBalance ? unvested6Months - ahAvailableBalance : 0n;
      const missing1Year = unvested1Year > ahAvailableBalance ? unvested1Year - ahAvailableBalance : 0n;
      const missing1Year2Months = unvested1Year2Months > ahAvailableBalance ? unvested1Year2Months - ahAvailableBalance : 0n;
      const missing1Year6Months = unvested1Year6Months > ahAvailableBalance ? unvested1Year6Months - ahAvailableBalance : 0n;

      if (missingNow > 0n) {
        accountsWithMissingVesting++;
        totalMissingVesting += missingNow;
      }

      console.log(`Account: ${ss58}`);
      console.log(`  Relay Chain:`);
      console.log(`    nonce: ${accountData.nonce}`);
      console.log(`    consumers: ${accountData.consumers}`);
      console.log(`    providers: ${accountData.providers}`);
      console.log(`    sufficients: ${accountData.sufficients}`);
      console.log(`    free: ${formatDOT(free)}`);
      console.log(`    reserved: ${formatDOT(reserved)}`);
      console.log(`    frozen: ${formatDOT(frozen)}`);
      console.log(`  Asset Hub:`);
      console.log(`    free: ${formatDOT(ahFree)}`);
      console.log(`    reserved: ${formatDOT(ahReserved)}`);
      console.log(`    frozen: ${formatDOT(ahFrozen)}`);
      console.log(`    AH available (free + reserved): ${formatDOT(ahAvailableBalance)}`);
      console.log(`  Vesting Projections:`);
      console.log(`    Now (block ${currentBlock}):`);
      console.log(`      Unvested: ${formatDOT(unvestedNow)}${missingNow > 0n ? ` | ⚠️  Missing: ${formatDOT(missingNow)}` : ''}`);
      console.log(`    +6 Months (block ${currentBlock + Number(BLOCKS_6_MONTHS)}):`);
      console.log(`      Unvested: ${formatDOT(unvested6Months)}${missing6Months > 0n ? ` | ⚠️  Missing: ${formatDOT(missing6Months)}` : ''}`);
      console.log(`    +1 Year (block ${currentBlock + Number(BLOCKS_1_YEAR)}):`);
      console.log(`      Unvested: ${formatDOT(unvested1Year)}${missing1Year > 0n ? ` | ⚠️  Missing: ${formatDOT(missing1Year)}` : ''}`);
      console.log(`    +1 Year 2 Months (block ${currentBlock + Number(BLOCKS_1_YEAR_2_MONTHS)}):`);
      console.log(`      Unvested: ${formatDOT(unvested1Year2Months)}${missing1Year2Months > 0n ? ` | ⚠️  Missing: ${formatDOT(missing1Year2Months)}` : ''}`);
      console.log(`    +1 Year 6 Months (block ${currentBlock + Number(BLOCKS_1_YEAR_6_MONTHS)}):`);
      console.log(`      Unvested: ${formatDOT(unvested1Year6Months)}${missing1Year6Months > 0n ? ` | ⚠️  Missing: ${formatDOT(missing1Year6Months)}` : ''}`);
      console.log("-".repeat(80));
    }
  }

  // Print summary
  console.log("\n" + "=".repeat(80));
  console.log("SUMMARY");
  console.log("=".repeat(80));
  console.log(`Total accounts in System.Account: ${totalSystemAccounts}`);
  console.log(`Accounts in RcMigrator.RcAccounts: ${rcMigratorAccounts.size}`);
  console.log(`Accounts with Vesting on Asset Hub: ${vestingAccounts.size}`);
  console.log("");
  console.log("Accounts NOT in RcMigrator but WITH Vesting on AH:");
  console.log(`  Count: ${accountsNotInRcMigrator}`);
  console.log(`  Total free balance: ${formatDOT(totalFreeBalance)}`);
  console.log(`  Total reserved balance: ${formatDOT(totalReservedBalance)}`);
  console.log(`  Total balance: ${formatDOT(totalFreeBalance + totalReservedBalance)}`);
  console.log("");
  console.log("Accounts IN RcMigrator AND WITH Vesting on AH:");
  console.log(`  Count: ${accountsInRcMigratorWithVesting}`);
  console.log(`  Total free balance: ${formatDOT(totalFreeBalanceInRcMigrator)}`);
  console.log(`  Total reserved balance: ${formatDOT(totalReservedBalanceInRcMigrator)}`);
  console.log(`  Total balance: ${formatDOT(totalFreeBalanceInRcMigrator + totalReservedBalanceInRcMigrator)}`);
  console.log(`  Accounts with missing vesting: ${accountsWithMissingVesting}`);
  console.log(`  Total missing vesting: ${formatDOT(totalMissingVesting)}`);
  console.log("=".repeat(80));

  // Properly terminate process
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
