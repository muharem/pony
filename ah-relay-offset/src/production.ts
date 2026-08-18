// Watch AH block production for two full authorship rounds and report collators
// that produced no blocks, then check how long they have not been producing
// (via CollatorSelection.LastAuthoredBlock).
//
// Aura on AH: author = Session.Validators[slot % n]; each collator gets one 24s
// slot window (up to 12 × 2s blocks) per round, a round = n consecutive windows.
// We watch 2 × n windows wall-clock (slot = unix_ms / 24s), count blocks per
// window from best heads, and flag collators whose watched windows are all empty.
//
// Run:
//   npx tsx src/production.ts            # two full rounds (~2·n·24s)
//   WINDOWS=4 npx tsx src/production.ts  # override watched window count (smoke test)
// Env: AH_WS overrides the RPC endpoint.
import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { ah } from "@polkadot-api/descriptors";

const AH_WS = process.env.AH_WS ?? "wss://statemint.api.onfinality.io/public-ws";
const ahub = createClient(getWsProvider(AH_WS));
const ahApi = ahub.getTypedApi(ah);

const SLOT_MS = 24_000;
const AH_BLOCK_MS = 2_000;
// Blocks of window s keep arriving after its wall end: the relay-parent offset
// plus gossip delays them by ~6–15s. Close a window only after this grace.
const GRACE_MS = 15_000;

const auraSlotFromHeader = (header: { digest: { logs: string[] } }): number | undefined => {
	// PreRuntime(0x06) + engine "aura" (0x61757261) + compact len 0x20 + u64 LE slot
	const log = header.digest.logs.find((l) => l.startsWith("0x0661757261"));
	if (!log) return undefined;
	const hex = log.slice(14, 30);
	let slot = 0n;
	for (let i = hex.length - 2; i >= 0; i -= 2)
		slot = (slot << 8n) | BigInt(parseInt(hex.slice(i, i + 2), 16));
	return Number(slot);
};

const validators = await ahApi.query.Session.Validators.getValue();
const n = validators.length;
const windows = Number(process.env.WINDOWS ?? 2 * n);
const startSlot = Math.floor(Date.now() / SLOT_MS) + 1; // first fully-watched window
const endSlot = startSlot + windows - 1;
console.log(
	`Collator set: ${n}. Watching ${windows} slot windows ` +
		`(slots ${startSlot}…${endSlot}, ~${Math.round((windows * SLOT_MS) / 60_000)} min).`,
);

// Count distinct block numbers per slot window (dedupes fork re-emissions).
const blocksPerSlot = new Map<number, number>();
const seenNumbers = new Set<number>();

const sub = ahub.bestBlocks$.subscribe({
	next: (blocks) => {
		for (const b of blocks) {
			if (seenNumbers.has(b.number)) continue;
			seenNumbers.add(b.number);
			ahub._request<{ digest: { logs: string[] } }, [string]>("chain_getHeader", [b.hash])
				.then((header) => {
					const slot = auraSlotFromHeader(header);
					if (slot !== undefined) blocksPerSlot.set(slot, (blocksPerSlot.get(slot) ?? 0) + 1);
				})
				.catch((e) => console.error(`[ah #${b.number}] header fetch failed:`, e));
		}
	},
	error: (e) => console.error("[ah] subscription error:", e),
});

// Close windows on wall clock; report each as it completes.
let nextToClose = startSlot;
await new Promise<void>((resolve) => {
	const timer = setInterval(() => {
		while (nextToClose <= endSlot && Date.now() > (nextToClose + 1) * SLOT_MS + GRACE_MS) {
			const s = nextToClose++;
			const idx = s % n;
			const count = blocksPerSlot.get(s) ?? 0;
			console.log(
				`window ${s - startSlot + 1}/${windows} slot=${s} collator[${idx}]=${validators[idx].slice(0, 6)} ` +
					`blocks=${count}${count === 0 ? "  ← MISSED" : ""}`,
			);
		}
		if (nextToClose > endSlot) {
			clearInterval(timer);
			resolve();
		}
	}, 1000);
	process.on("SIGINT", () => {
		clearInterval(timer);
		resolve();
	});
});
sub.unsubscribe();

// Aggregate per collator over the windows actually watched (closed).
const watched = new Map<number, number[]>(); // idx -> block counts per watched window
for (let s = startSlot; s < nextToClose; s++)
	watched.set(s % n, [...(watched.get(s % n) ?? []), blocksPerSlot.get(s) ?? 0]);

const nonProducers = [...watched.entries()]
	.filter(([, counts]) => counts.every((c) => c === 0))
	.map(([idx]) => idx);

if (nonProducers.length === 0) {
	console.log(`\nAll ${watched.size} watched collators produced blocks.`);
} else {
	console.log(`\nNon-producing collators (${nonProducers.length}/${watched.size} watched):`);
	// How long have they not been producing? CollatorSelection.LastAuthoredBlock
	// stores the AH block each collator last authored (note: the value is also
	// seeded when a candidate registers, so treat it as an upper bound).
	// Candidates that stop authoring get kicked at the session change, so a
	// long-dead collator in the set is normally an invulnerable (exempt from
	// kicking) — label each accordingly.
	const [tip, invulnerables] = await Promise.all([
		ahub.getFinalizedBlock(),
		ahApi.query.CollatorSelection.Invulnerables.getValue(),
	]);
	for (const idx of nonProducers) {
		const addr = validators[idx];
		const kind = invulnerables.includes(addr) ? "invulnerable" : "candidate (kickable)";
		const last = await ahApi.query.CollatorSelection.LastAuthoredBlock.getValue(addr);
		if (last === 0) {
			console.log(`  [${idx}] ${addr} [${kind}] — no authoring record on chain`);
		} else {
			const blocksAgo = tip.number - last;
			const hours = ((blocksAgo * AH_BLOCK_MS) / 3_600_000).toFixed(1);
			console.log(
				`  [${idx}] ${addr} [${kind}] — last authored #${last}, ${blocksAgo} blocks (~${hours}h) ago`,
			);
		}
	}
}

ahub.destroy();
process.exit(0);
