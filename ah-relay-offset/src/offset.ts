// Method A: live watcher of the relay-parent offset of Asset Hub blocks.
//
// Subscribes to relay-chain and AH best heads. For every new AH block it reads
// the relay parent set by the ParachainSystem.ValidationData inherent and
// compares it to the relay tip our node sees at that moment:
//   offset   = relay tip now − relay parent (1 expected: AH RELAY_PARENT_OFFSET)
//   tipAge   = how long ago that relay tip arrived at our node
//   collator = AH block author (Aura slot → Session.Validators)
// Offsets bigger than OFFSET_ALERT are collected and reported on exit.
//
// Run:
//   npx tsx src/offset.ts               # until Ctrl-C
//   RUN_SECS=60 npx tsx src/offset.ts   # auto-stop after 60s
// Env: RELAY_WS / AH_WS override the RPC endpoints.
import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { ah } from "@polkadot-api/descriptors";

const RELAY_WS = process.env.RELAY_WS ?? "wss://polkadot.api.onfinality.io/public-ws";
const AH_WS = process.env.AH_WS ?? "wss://statemint.api.onfinality.io/public-ws";

const relay = createClient(getWsProvider(RELAY_WS));
const ahub = createClient(getWsProvider(AH_WS));
const ahApi = ahub.getTypedApi(ah);

const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(7);

const OFFSET_ALERT = 3;
type Anomaly = { ah: number; relayParent: number; relayTip: number; offset: number };
const anomalies: Anomaly[] = [];

// ── Relay tip tracker ───────────────────────────────────────────────────────
// A new relay tip = block authored by a validator, gossiped, and imported by our
// RPC node (~0.1–1s after authoring). Best head, not finalized — can reorg.
// Ring buffer of relay best heads with local arrival time, newest first.
type RelayHead = { number: number; hash: string; arrivedAt: number };
const relayHeads: RelayHead[] = [];
const RING_CAP = 600;

relay.bestBlocks$.subscribe({
	next: (blocks) => {
		const tip = blocks[0];
		if (relayHeads[0]?.hash === tip.hash) return;
		relayHeads.unshift({ number: tip.number, hash: tip.hash, arrivedAt: Date.now() });
		if (relayHeads.length > RING_CAP) relayHeads.pop();
		console.log(`${elapsed()} [relay] tip #${tip.number}`);
	},
	error: (e) => console.error(`${elapsed()} [relay] error:`, e),
});

// Collator identity: the Aura pre-runtime digest in the AH header carries the
// slot; the author is authorities[slot % n], and Session.Validators holds the
// collator account IDs in the same order.
const auraSlotFromHeader = (header: { digest: { logs: string[] } }): bigint | undefined => {
	// PreRuntime(0x06) + engine "aura" (0x61757261) + compact len 0x20 + u64 LE slot
	const log = header.digest.logs.find((l) => l.startsWith("0x0661757261"));
	if (!log) return undefined;
	const hex = log.slice(14, 30);
	let slot = 0n;
	for (let i = hex.length - 2; i >= 0; i -= 2)
		slot = (slot << 8n) | BigInt(parseInt(hex.slice(i, i + 2), 16));
	return slot;
};

// The collator set only changes at session boundaries — cache it briefly.
let cachedValidators: string[] = [];
let validatorsFetchedAt = 0;
const getValidators = async (at: string): Promise<string[]> => {
	if (Date.now() - validatorsFetchedAt > 60_000) {
		cachedValidators = await ahApi.query.Session.Validators.getValue({ at });
		validatorsFetchedAt = Date.now();
	}
	return cachedValidators;
};

// ── AH watcher — relay parent vs relay tip at arrival ──────────────────────
// A new AH tip = block just authored by the collator (every 2s) and announced on
// the parachain p2p network; full nodes import it as best immediately, before the
// candidate is backed/included on the relay chain (so it is still provisional).
let lastAh = -1;
ahub.bestBlocks$.subscribe({
	next: async (blocks) => {
		const tip = blocks[0];
		if (tip.number === lastAh) return;
		lastAh = tip.number;
		const arrivedAt = Date.now();
		const relayTip = relayHeads[0];

		try {
			// ValidationData is set by the mandatory set_validation_data inherent.
			const [vd, rawHeader, validators] = await Promise.all([
				ahApi.query.ParachainSystem.ValidationData.getValue({ at: tip.hash }),
				ahub._request<{ digest: { logs: string[] } }, [string]>("chain_getHeader", [tip.hash]),
				getValidators(tip.hash),
			]);
			const slot = auraSlotFromHeader(rawHeader);
			const collator =
				slot !== undefined && validators.length > 0
					? validators[Number(slot % BigInt(validators.length))]
					: "?";
			if (!vd) {
				console.log(`${elapsed()} [ah #${tip.number}] no ValidationData`);
				return;
			}
			const relayParent = vd.relay_parent_number;
			if (!relayTip) {
				console.log(
					`${elapsed()} [ah #${tip.number}] relayParent=${relayParent} (relay tip unknown yet)`,
				);
				return;
			}
			const offset = relayTip.number - relayParent;
			if (offset > OFFSET_ALERT)
				anomalies.push({ ah: tip.number, relayParent, relayTip: relayTip.number, offset });
			const tipAge = ((arrivedAt - relayTip.arrivedAt) / 1000).toFixed(1);
			console.log(
				`${elapsed()} [ah #${tip.number}] relayParent=${relayParent} relayTip=${relayTip.number} offset=${offset} tipAge=${tipAge}s collator=${collator.slice(0, 6)}`,
			);
		} catch (e) {
			console.error(`${elapsed()} [ah #${tip.number}] failed to read block data:`, e);
		}
	},
	error: (e) => console.error(`${elapsed()} [ah   ] error:`, e),
});

const shutdown = () => {
	if (anomalies.length === 0) {
		console.log(`\nNo offsets > ${OFFSET_ALERT} observed.`);
	} else {
		console.log(`\nOffsets > ${OFFSET_ALERT} observed (${anomalies.length}):`);
		for (const a of anomalies)
			console.log(
				`  ah #${a.ah} relayParent=${a.relayParent} relayTip=${a.relayTip} offset=${a.offset}`,
			);
	}
	relay.destroy();
	ahub.destroy();
	process.exit(0);
};
process.on("SIGINT", shutdown);

const runSecs = Number(process.env.RUN_SECS ?? 0);
if (runSecs > 0) setTimeout(shutdown, runSecs * 1000);
