# Offline caching census — PaySwift 100K, 30 queries, 38 shards

Implicit-cache floor used: 4096 tokens (gemini-3.5-flash, verified 2026-06-10).

| Stage | Calls | Avg req tokens | Max req tokens | ≥ floor | Avg stable prefix (tok) | Max stable prefix |
|---|---:|---:|---:|---:|---:|---:|
| probe | 240 | 557.3 | 701 | 0 | 178 | 211 |
| recall | 120 | 1383.5 | 1676 | 0 | 571 | 1289 |
| synth | 30 | 635.5 | 861 | 0 | - | - |

**Reading:** a request can only ever produce an implicit cache hit if (a) its total size reaches the floor AND (b) its leading bytes repeat across calls. Today neither holds: every probe/recall request sits far below 4096 tokens, and the cross-query stable prefix is only the ~140-token SHARD_SYSTEM_PROMPT + shard header + summary (Discovery B).

## Restructure options (brief Q3), per touched shard

| Shard | R1: stable full probe index (system tok) | R3: full event digest (tok) |
|---|---:|---:|
| f1-brassroots-architecture | 412 | 2862 |
| f1-brassroots-compliance | 206 | 585 |
| f1-brassroots-customers | 238 | 824 |
| f1-brassroots-incidents | 209 | 901 |
| f1-brassroots-meta | 204 | 486 |
| f1-brassroots-product | 275 | 1543 |
| f1-klipboard-architecture | 347 | 2108 |
| f1-klipboard-compliance | 209 | 452 |
| f1-klipboard-customers | 388 | 2848 |
| f1-klipboard-finance | 239 | 869 |
| f1-mealhaul-architecture | 411 | 1963 |
| f1-mealhaul-compliance | 211 | 411 |
| f1-mealhaul-customers | 320 | 1254 |
| f1-mealhaul-finance | 204 | 326 |
| f1-mealhaul-incidents | 209 | 448 |
| f1-mealhaul-meta | 305 | 1748 |
| f1-mealhaul-product | 239 | 550 |
| f1-stagewise-architecture | 280 | 1018 |
| f1-stagewise-customers | 353 | 1685 |
| f1-tidepool-architecture | 309 | 1814 |
| f1-tidepool-customers | 524 | 4359 |
| s-architecture | 1677 | 19432 |
| s-compliance | 886 | 8822 |
| s-customers | 883 | 8126 |
| s-finance | 633 | 5687 |
| s-incidents | 714 | 7725 |
| s-meta | 884 | 9998 |
| s-people | 451 | 3285 |
| s-product | 674 | 5920 |

Averages: R1 stable probe system 445 tok (clears the 4096 floor on 0/29 shards); R3 full digest 3381 tok (clears it on 8/29).
