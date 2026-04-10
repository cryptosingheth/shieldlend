# Session 6 — 2026-04-09 — V2A+ Privacy Features (A–E) + 3-Round Security Audit

**Branch**: `v2a-architecture`  
**Commits**: `345398f`, `4059fb8`

## What Was Built

### Privacy Features A–E (all complete)

**Feature A — ERC-5564 Stealth Addresses** (`stealthKeyContext.tsx`)  
Withdrawal recipient is a fresh stealth address per withdrawal — no on-chain link to user's MetaMask wallet. Uses `@scopelift/stealth-address-sdk`. Spend key + view key derived via HKDF from wallet signature. User imports private key to MetaMask post-withdrawal.

**Feature B — Server-Side Deposit Relay** (`api/deposit/route.ts`)  
All deposit transactions submitted by the server deployer wallet. User's wallet never appears in any on-chain transaction (`tx.from` = server, not user).

**Feature C — Auditor Viewing Keys** (`viewingKeyContext.tsx`)  
Separate AES-256-GCM key derived via HKDF with different salt than note key. Sharing viewing key hex allows auditor to decrypt all notes but cannot generate ZK proofs (no nullifier/secret). Zcash transparent disclosure model.

**Feature D — On-Chain Encrypted Notes** (`ShieldedPool.deposit()`)  
`deposit(bytes32 commitment, bytes encryptedNote)` — AES-256-GCM ciphertext appended to `Deposit` event. Notes recoverable from chain using viewing key even after localStorage clear.

**Feature E — CREATE2 Shard Factory** (`ShieldedPoolFactory.sol`)  
5 independent ShieldedPool contracts. Max 20% blast radius per exploit. Protocol obfuscation: observer sees 5 different contract addresses. Server picks random shard per deposit.

### Security Audit — 3 Rounds, 16 Fixes

**Round 1 (reentrancy + architecture):**
- `nonReentrant` on: `withdraw()`, `flushEpoch()`, `disburseLoan()`, `repay()`, `liquidate()`, `settleCollateral()`
- `NullifierRegistry` V2A rewrite: multi-shard `mapping(address=>bool)` + `registerShard()`
- `pushRoot()` validates `root == shard.getLastRoot()` (blocks cross-shard root injection)
- `flushEpoch()`: state updates before tip transfer (was reentrancy vector)
- `repay()`: added `unlockNullifier()` call (collateral was permanently frozen)
- `ShieldedPool`: `_admin` constructor param (forge script mis-assigned admin to script contract)

**Round 2 (logic):**
- `settleCollateral()`: `hasActiveLoan` guard (loan-0 mapping default corruption)
- `settleCollateral()`: `msg.sender == collateralShard` ownership check
- `settleCollateral()`: `msg.value >= totalOwed` validation
- `encryptedNote.length <= 256` cap in `deposit()`
- `nextLoanId = 1` in constructor (0 is unambiguous null sentinel)

**Round 3 (ETH flow):**
- `settleCollateral()`: forwards ETH to `disburseShard` (was permanently draining shard liquidity)
- `ShieldedPoolFactory`: constructor registers all shards with NullifierRegistry + LendingPool atomically

**Accepted (not fixed):**
- R3-H3: ZkVerify operator immutable — acceptable testnet; needs multisig before mainnet
- R3-M2: `block.prevrandao` Fisher-Yates bias — L2 limitation; VRF would need circuit change

## Deployed Contracts — Base Sepolia — V2A Final (2026-04-09)

| Contract | Address |
|----------|---------|
| NullifierRegistry V2A | `0xe7B4C2B6ae962EFFCDc9797c5E23E592275ac411` |
| LendingPool V2A | `0x1Ff7FD0bdF660c82158729A9c74F6DD6F6f2988d` |
| Shard 1 | `0xa99F12A4340A47FD3075Ae0352Fca77b13bF0d61` |
| Shard 2 | `0x7488f4f7Ae7A98e1C7B3815C310404f7bFDc2203` |
| Shard 3 | `0xf859Ab35bC212dc2bBC90DF8d86Ff36243b698d8` |
| Shard 4 | `0x5F9298DaeB820dC40AF9C8cf2a9B339a111b52Ea` |
| Shard 5 | `0x1a1070AcB0542F9A39E18b32151A18dF97Eaf3E4` |

## Test Suite
86/86 passing (GasTest: 8, LendingPoolTest: 35, SecurityAuditTest: 10, ShieldedPoolTest: 33)
