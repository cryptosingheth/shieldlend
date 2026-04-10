# ShieldLend V2 — Project Claude Instructions

## Auto-Update Rule (IMPORTANT — follow without being asked)

After EVERY session where ANY of the following happens:
- A contract is modified or redeployed
- A new feature is implemented
- A bug fix changes a design decision
- A security audit finding leads to a code change
- A cross-session architectural trade-off is made

You MUST append a new ADR entry to `/Users/opinderpreetsingh/shieldlend-v2/ARCHITECTURE_DECISIONS.md`
using the established format:

```
### ADR-N: Title
**Status**: Decided | Superseded (by ADR-X)
**When**: Session N / Version label
**Decision**: One sentence.
**Alternatives considered**: ...
**Rationale**: ...
**Consequences**: ...
```

Do this BEFORE committing. Do not wait to be asked.

If unsure whether something warrants a new ADR, add it — over-documentation is preferred.  
If an existing ADR is superseded, update its **Status** field to `Superseded by ADR-N`.  
Update the `*Last updated*` line at the bottom of `ARCHITECTURE_DECISIONS.md` each session.

---

## Project Quick Reference

- Repo: `/Users/opinderpreetsingh/shieldlend-v2/`
- Current version: V2B (cross-shard withdrawal)
- Test command: `cd contracts && forge test`
- Dev server: `cd frontend && npm run dev`
- Live test: `node frontend/live-test.mjs`
- Deploy script: `contracts/script/DeployV2B.s.sol`
- VK hash (withdraw_ring): `0x1702813c4e71d1e48547214eae39ad1b2d07d3643713094e92e619f4f2b0e572`
- Git config: always verify `git config user.email` = `opinderpreet@gmail.com` before first commit

---

## V2B Deployed Contracts (Base Sepolia, Chain ID 84532 — 2026-04-10)

Full addresses in `frontend/.env.local` (not committed).

| Contract | Address |
|----------|---------|
| Shard 1 (= SHIELDED_POOL_ADDRESS) | `0xcF78eaEA131747c67BBD1869130f0710bA646D8D` |
| Shard 2 | `0x3110C104542745c55cCA31A63839F418d1354F5D` |
| Shard 3 | `0x39769faD54c21d3D8163D9f24F63473eCC528bE0` |
| Shard 4 | `0x02dfe4aed5Ba2A2085c80F8Fe7c20686d047111B` |
| Shard 5 | `0xf3F7C4c1a352371eC3ae7e70387c259c7051b348` |
| LendingPool | `0xA1d0F1A35F547698031F14fE984981632AC26240` |
| NullifierRegistry | `0xEBC14761D4A2E30771E422F52677ed17896ec21F` |
| ZkVerifyAggregation | `0x8b722840538d9101bfd8c1c228fb704fbe47f460` |
| Relay wallet (deployer) | `0x6D4b038B3345acb06B8fDCA1bEAC24c731A44Fb2` |

---

## Architecture Invariants (DO NOT BREAK)

1. **Shared vkHash**: all 5 shards use the same `vkHash` — never redeploy with a different circuit without updating ALL shards and the vkHash
2. **LendingPool is accounting-only**: it never holds user ETH — all ETH custody is in ShardPool contracts
3. **Global nullifier registry**: NullifierRegistry is shared across all shards — never bypass it or allow a shard to have its own nullifier set
4. **Feature D always present**: Deposit events must include `encryptedNote bytes` — do not silently remove it
5. **pushRoot validated**: `LendingPool.pushRoot()` must validate `root == IShieldedPool(msg.sender).getLastRoot()` — never accept arbitrary roots
6. **Binary note packing**: encrypted notes use 72-byte binary pack (not JSON) to stay under the 256-byte cap

---

## Pending Work (update as completed)

- [ ] Live-test borrow + repay flow end-to-end on Base Sepolia
- [ ] Viewing key recovery UI (Feature C): `viewingKeyContext.tsx` exists but no recovery page yet
- [ ] Replace ZkVerify operator with multisig before mainnet (accepted audit finding H-3)
- [ ] Consider Chainlink VRF for Fisher-Yates shuffle (accepted audit finding M-2)
- [ ] Auto-forward ETH from stealth address to MetaMask wallet (UX improvement — currently user must manually import key)

---

## Test Suite

86/86 tests passing as of V2B:
- `GasTest` (8 tests)
- `LendingPoolTest` (35 tests)
- `SecurityAuditTest` (10 tests)
- `ShieldedPoolTest` (33 tests)

Run: `cd /Users/opinderpreetsingh/shieldlend-v2/contracts && forge test`

Live test (32/32 passing against V2B contracts):
`node /Users/opinderpreetsingh/shieldlend-v2/frontend/live-test.mjs`
