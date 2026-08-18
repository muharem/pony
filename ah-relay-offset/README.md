# ah-relay-offset

Small scripts to observe the offset between the relay parent anchored in
Polkadot Asset Hub (para 1000) blocks and the relay-chain tip.

Context: every AH block carries its relay parent in the
`ParachainSystem.ValidationData` inherent. The collator anchors it
`RELAY_PARENT_OFFSET` (= 1 on AH) blocks behind its relay tip, so the expected
live offset is 1. Deviations indicate a collator falling behind, forks, or
authoring gaps.

## Setup

```bash
npm install   # also regenerates PAPI descriptors (postinstall)
```

## Scripts

### `src/offset.ts` — Method A: live gossip view

Subscribes to relay + AH best heads. For each new AH block logs its relay
parent, the relay tip our node sees at that moment, the offset between them,
the age of that tip, and the authoring collator. Offsets > 3 are summarized on
exit.

```bash
npx tsx src/offset.ts               # until Ctrl-C
RUN_SECS=60 npx tsx src/offset.ts   # auto-stop after 60s
```

### `src/backed.ts` — Method B: on-chain backing view

Relay-only and deterministic: for each relay block reads
`ParachainHost.candidate_events` and logs every backed AH candidate with its
relay parent and `offset = backingBlock − relayParent`. Works live or over a
historical block range. Offsets > 3 are summarized on exit.

```bash
npx tsx src/backed.ts                                  # live, until Ctrl-C
RUN_SECS=60 npx tsx src/backed.ts                      # live, auto-stop
npx tsx src/backed.ts --from 32591800 --to 32591820    # historical range
```

### `src/production.ts` — collator production watcher

Watches AH block production for two full authorship rounds (Aura round-robin:
each collator gets one 24s window of up to 12 blocks per round; a round is
`n` windows for `n` collators — with 14 collators two rounds take ~11 min).
Reports each window as it closes, then lists collators whose watched windows
were all empty, with how long they have not been authoring (from
`CollatorSelection.LastAuthoredBlock`; note the value is also seeded on
candidate registration, so treat it as an upper bound).

```bash
npx tsx src/production.ts             # two full rounds
WINDOWS=4 npx tsx src/production.ts   # custom window count (quick check)
```

## Environment variables

| Variable   | Default                          | Used by                      |
| ---------- | -------------------------------- | ---------------------------- |
| `RELAY_WS` | OnFinality public Polkadot WS    | `offset.ts`, `backed.ts`     |
| `AH_WS`    | OnFinality public Asset Hub WS   | `offset.ts`, `production.ts` |
| `PARA_ID`  | `1000` (Asset Hub)               | `backed.ts`                  |
| `RUN_SECS` | unset (run until Ctrl-C)         | `offset.ts`, `backed.ts`     |
| `WINDOWS`  | `2 × collator count` (2 rounds)  | `production.ts`              |

Public endpoints are rate-limited; for long runs use your own key/endpoint.
