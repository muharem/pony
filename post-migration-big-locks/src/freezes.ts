import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/web";
import { withPolkadotSdkCompat } from "polkadot-api/polkadot-sdk-compat";
import { dot } from "@polkadot-api/descriptors";
import { ah } from "@polkadot-api/descriptors";

/**
 * This script retrieves all accounts from RcMigrator.RcAccounts (on Relay Chain/Polkadot), then:
 * - For each account, fetches the account data from the Asset Hub parachain via their own endpoint.
 * - Prints accounts that have locks AND where frozen > (free + reserved) on Asset Hub.
 * - These are problematic accounts where the frozen amount exceeds available balance.
 * 
 * NOTE: This requires a working polkadot-api descriptor for Asset Hub as well as correct endpoints.
 */

const RELAY_CHAIN_WS = "wss://rpc.polkadot.io";
const ASSET_HUB_WS = "wss://polkadot-asset-hub-rpc.polkadot.io"; // Update as needed

const DOT = 10_000_000_000n;

// Helper function to format balance in DOT with 3 decimal places
function formatDOT(amount: bigint | number): string {
  const amt = BigInt(amount);
  const whole = amt / DOT;
  const remainder = amt % DOT;
  const decimal = (Number(remainder) / Number(DOT)).toFixed(3).substring(2); // Get 3 decimals
  return `${whole}.${decimal} DOT`;
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

  // Fetch accounts from RcMigrator.RcAccounts on the relay chain
  const entries = await relayApi.query.RcMigrator.RcAccounts.getEntries();

  // Stats tracking
  let totalAccounts = 0;
  let accountsWithLocks = 0;

  // For each account:
  for (const entry of entries) {
    totalAccounts++;
    const ss58 = entry.keyArgs[0]; // storage map key: SS58 address string
    const relayValue = entry.value;

    try {
      // Fetch account info from Asset Hub
      const accountInfo = await assetHubApi.query.System.Account.getValue(ss58);

      // All balance locks
      const balanceLocks = await assetHubApi.query.Balances.Locks.getValue(ss58);
      let locksList: any[] = [];
      if (balanceLocks) {
        if (Array.isArray(balanceLocks)) {
          locksList = balanceLocks;
        } else if (balanceLocks.locks && Array.isArray(balanceLocks.locks)) {
          locksList = balanceLocks.locks;
        }
      }

      // Only print accounts with locks
      const hasLocks = locksList && locksList.length > 0;
      
      // Check if frozen > free + reserved on Asset Hub
      const frozen = accountInfo.data.frozen;
      const freeAndReserved = accountInfo.data.free + accountInfo.data.reserved;
      const frozenExceedsBalance = frozen > freeAndReserved;

      if (hasLocks && frozenExceedsBalance) {
        accountsWithLocks++;

        console.log("Relay Chain RcAccount");
        console.log("  SS58:", ss58);
        
        // Format relay chain values
        if (relayValue.type === "Part") {
          console.log("  RcMigrator::RcAccounts:");
          console.log(`    free: ${formatDOT(relayValue.value.free)}`);
          console.log(`    reserved: ${formatDOT(relayValue.value.reserved)}`);
          console.log(`    consumers: ${relayValue.value.consumers}`);
        } else {
          console.log("  RcMigrator::RcAccounts value:", relayValue);
        }
        
        // Format Asset Hub account info
        console.log("  [Asset Hub] System.Account:");
        console.log(`    nonce: ${accountInfo.nonce}`);
        console.log(`    consumers: ${accountInfo.consumers}`);
        console.log(`    providers: ${accountInfo.providers}`);
        console.log(`    sufficients: ${accountInfo.sufficients}`);
        console.log("    data:");
        console.log(`      free: ${formatDOT(accountInfo.data.free)}`);
        console.log(`      reserved: ${formatDOT(accountInfo.data.reserved)}`);
        console.log(`      frozen: ${formatDOT(accountInfo.data.frozen)}`);
        const deficit = frozen - freeAndReserved;
        console.log(`      ⚠️  DEFICIT: ${formatDOT(deficit)} (frozen exceeds free+reserved)`);

        console.log("  [Asset Hub] Balance Locks:");
        for (const lock of locksList) {
          const lockId = lock.id?.asText?.() ?? lock.id?.asHex?.() ?? lock.id;
          const amount = lock.amount?.toString?.() ?? lock.amount;
          console.log(
            "    - Id:",
            lockId,
            "Amount:",
            formatDOT(amount),
            "Reasons:",
            lock.reasons ?? ""
          );
        }

        console.log("=".repeat(60));
      }
    } catch (e) {
      console.error(`  [Asset Hub] Failed to fetch info for ${ss58}:`, e);
    }
  }

  // Print summary
  console.log("\n" + "=".repeat(60));
  console.log("SUMMARY");
  console.log("=".repeat(60));
  console.log(`Total accounts in RcMigrator.RcAccounts: ${totalAccounts}`);
  console.log(`Accounts with locks AND frozen > (free + reserved): ${accountsWithLocks}`);
  console.log("=".repeat(60));

  // Properly terminate process (for script usage)
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
