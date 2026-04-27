# Runtime JSONL Compact Schema

This document records the mapping between compact JSONL keys emitted by BodyMonitorCore runtime code and the verbose field names exposed by MindWaveCore server parsers.

The mapping is implemented in code, not generated from a shared schema file.

Authoritative implementation points:

- Pascal timestamp keys: `SharedPasCore/JsonLogWriter.pas`
- Pascal runtime emitters: `BodyMonitorCore/cli/core/HeartRateReader.pas`
- Pascal EEG/algo emitters: `BodyMonitorCore/cli/core/BodyMonitorCore.pas`
- TypeScript parser expansion: `MindWaveCore/server/protocol.ts`
- Archive event detection: `MindWaveCore/server/log-db.ts`

## Common keys

| JSONL key | Verbose name | Notes |
|---|---|---|
| `ap` | `app` | Runtime/app source tag from `jsonLogTimestamp` |
| `t` | `ts` | String timestamp |
| `tk` | `ticks` | Tick counter |
| `ep` | `epoch` | Numeric UNIX timestamp in seconds |
| `e` | `event` | Compact event discriminator |

## Event discriminator values

| `e` value | Verbose event name |
|---|---|
| `hr` | `hr_notification` |
| `bp` | `breath_phase` |
| `s` | `snapshot` |
| `ab` | `algo_blink` |
| `ap` | `algo_bp` |

These same compact event names are also used by archive detection in `log-db.ts`.

## hr_notification

| JSONL key | Verbose name |
|---|---|
| `h` | `hr` |
| `r` | `rr` |

## breath_phase

| JSONL key | Verbose name |
|---|---|
| `p` | `phase` |
| `x` | `extremum` |
| `h` | `hr` |
| `r0` | `rr_raw_ms` |
| `r1` | `rr_smooth_ms` |
| `dm` | `delta_ms` |
| `si` | `sample_index` |

Value mapping:

| Compact value | Verbose value |
|---|---|
| `p: "i"` | `phase: "inhale"` |
| `p: "e"` | `phase: "exhale"` |
| `x: "pk"` | `extremum: "peak"` |
| `x: "vy"` | `extremum: "valley"` |

## snapshot

| JSONL key | Verbose name |
|---|---|
| `rw` | `raw` |
| `ps` | `poorSignal` |
| `at` | `attention` |
| `md` | `meditation` |
| `d` | `delta` |
| `th` | `theta` |
| `a1` | `alpha1` |
| `a2` | `alpha2` |
| `b1` | `beta1` |
| `b2` | `beta2` |
| `g1` | `gamma1` |
| `g2` | `gamma2` |

`th` is used for theta because `t` is already reserved by the common timestamp key.

## algo_blink

| JSONL key | Verbose name |
|---|---|
| `sg` | `strength` |

## algo_bp

| JSONL key | Verbose name |
|---|---|
| `d` | `delta` |
| `th` | `theta` |
| `a` | `alpha` |
| `b` | `beta` |
| `g` | `gamma` |

## Server-side expansion

MindWaveCore server expands compact JSONL back into verbose TypeScript event objects in `protocol.ts`:

- `ep -> epoch`
- `t -> ts`
- `hr -> h/r`
- `bp -> p/x/h/r0/r1/dm/si`
- `s -> rw/ps/at/md/d/th/a1/a2/b1/b2/g1/g2`

Charts, archive views, and replay consumers should use the verbose TypeScript properties, not the compact JSONL keys directly.