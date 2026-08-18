// Method B: measure the AH relay-parent offset from the relay chain itself.
//
// For each relay block we read `ParachainHost.candidate_events` and pick the
// CandidateBacked events for our para. A candidate backed in relay block N with
// relay parent P was gossiped by the collator before N was authored, so
// `offset = N - P` is the protocol-level lag between the anchor and landing on
// chain — deterministic, no dependence on our own network view, and it works on
// historical blocks. Offsets bigger than OFFSET_ALERT are collected and
// reported on exit.
//
// Run:
//   npx tsx src/backed.ts                            # live, until Ctrl-C
//   RUN_SECS=60 npx tsx src/backed.ts                # live, auto-stop after 60s
//   npx tsx src/backed.ts --from 32591800 --to 32591820   # historical range
// Env: RELAY_WS overrides the RPC endpoint; PARA_ID the parachain (default 1000).
import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { dot } from "@polkadot-api/descriptors";

const RELAY_WS = process.env.RELAY_WS ?? "wss://polkadot.api.onfinality.io/public-ws";
const PARA_ID = Number(process.env.PARA_ID ?? 1000); // Asset Hub

const relay = createClient(getWsProvider(RELAY_WS));
const dotApi = relay.getTypedApi(dot);

// Candidate events carry the relay parent as a hash; resolve numbers via header
// lookups, cached (every processed block seeds the cache too).
const numberByHash = new Map<string, number>();
const blockNumber = async (hash: string): Promise<number> => {
	const cached = numberByHash.get(hash);
	if (cached !== undefined) return cached;
	const header: any = await relay._request("chain_getHeader", [hash]);
	const n = parseInt(header.number, 16);
	numberByHash.set(hash, n);
	return n;
};

const OFFSET_ALERT = 3;
type Anomaly = { relayBlock: number; relayParent: number; offset: number; core: number };
const anomalies: Anomaly[] = [];

const processBlock = async (number: number, hash: string) => {
	numberByHash.set(hash, number);
	const events = await dotApi.apis.ParachainHost.candidate_events({ at: hash });
	for (const ev of events) {
		if (ev.type !== "CandidateBacked") continue;
		const [receipt, , coreIndex] = ev.value as any[];
		const d = receipt.descriptor;
		if (d.para_id !== PARA_ID) continue;
		const relayParent = await blockNumber(d.relay_parent);
		const offset = number - relayParent;
		if (offset > OFFSET_ALERT)
			anomalies.push({ relayBlock: number, relayParent, offset, core: coreIndex });
		console.log(
			`[relay #${number}] backed relayParent=${relayParent} offset=${offset} core=${coreIndex}`,
		);
	}
};

const reportAndExit = () => {
	if (anomalies.length === 0) {
		console.log(`\nNo offsets > ${OFFSET_ALERT} observed.`);
	} else {
		console.log(`\nOffsets > ${OFFSET_ALERT} observed (${anomalies.length}):`);
		for (const a of anomalies)
			console.log(
				`  relay #${a.relayBlock} relayParent=${a.relayParent} offset=${a.offset} core=${a.core}`,
			);
	}
	relay.destroy();
	process.exit(0);
};
process.on("SIGINT", reportAndExit);

const argAfter = (flag: string) => {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? Number(process.argv[i + 1]) : undefined;
};
const from = argAfter("--from");
const to = argAfter("--to");

if (from !== undefined && to !== undefined) {
	// Historical range scan — paced with retries to stay under public rate limits.
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	for (let n = from; n <= to; n++) {
		for (let attempt = 1; ; attempt++) {
			try {
				const hash: string = await relay._request("chain_getBlockHash", [n]);
				await processBlock(n, hash);
				break;
			} catch (e) {
				if (attempt >= 3) {
					console.error(`[relay #${n}] failed after ${attempt} attempts:`, e);
					break;
				}
				await sleep(2000 * attempt);
			}
		}
		await sleep(150);
	}
	reportAndExit();
} else {
	// Live: follow best heads.
	let lastHash = "";
	relay.bestBlocks$.subscribe({
		next: (blocks) => {
			const tip = blocks[0];
			if (tip.hash === lastHash) return;
			lastHash = tip.hash;
			processBlock(tip.number, tip.hash).catch((e) =>
				console.error(`[relay #${tip.number}] failed:`, e),
			);
		},
		error: (e) => console.error("[relay] error:", e),
	});
	const runSecs = Number(process.env.RUN_SECS ?? 0);
	if (runSecs > 0) setTimeout(reportAndExit, runSecs * 1000);
}
