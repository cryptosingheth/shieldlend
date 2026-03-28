# ShieldLend — Competitive Analysis

A review of existing projects that attempted private DeFi lending or privacy-enhanced DeFi, what they proved, what failed, and what ShieldLend learns from each.

---

## Comparison Table

| Project | Approach | Chain | Status | Key Lesson |
|---------|----------|-------|--------|------------|
| **Sacred Finance** | Tornado Cash fork + Aave yield integration | Ethereum | Launched (low adoption) | Proves the concept works technically. Low adoption was an ecosystem/timing problem, not a technical one. |
| **zkFi** | Multi-asset privacy pool with stateless Aave proxy | Ethereum | Research / early stage | Best academic reference for the circuit architecture. Their withdrawal circuit design directly informs `withdraw.circom`. |
| **Zkredit** | MPC-based private lending (not ZK proofs) | Solana | Building | Shows the demand for private lending. Chose MPC because ZK verification was too expensive on Solana — zkVerify removes this objection on EVM. |
| **Aztec Connect** | Full privacy L2 rollup over Ethereum DeFi | Ethereum L2 | Shut down March 2023 | Building a full privacy L2 is too complex for a small team. Feature-level privacy on an existing chain is the right scope. |
| **Cardano ZK Lending** | ZK privacy for Cardano DeFi lending | Cardano | Funded, in development | Same concept, different ecosystem and proof system — confirms the market need. |

---

## Deep Dives

### Sacred Finance

Sacred Finance was a direct fork of Tornado Cash with Aave yield added. Users deposited into a shielded pool (Tornado Cash pattern), and their deposits earned yield via Aave in the background. Withdrawals were unlinkable to deposits, same as Tornado Cash.

**What it proved**:
- The Tornado Cash pattern (commitment → Merkle tree → nullifier → unlock) works for DeFi, not just simple transfers
- Adding yield to a shielded pool is technically feasible
- The demand for private DeFi exists

**Why it had low adoption**:
- Launched in a difficult regulatory climate (post-Tornado Cash OFAC sanctions)
- Gas costs for on-chain Groth16 verification were high ($30+ per withdrawal on L1)
- Limited marketing and ecosystem support

**What ShieldLend takes from it**: The core architecture. ShieldLend is essentially Sacred Finance with two improvements — zkVerify for 91% cheaper proof verification, and Horizen L3 as the chain (which is purpose-built for privacy DeFi).

---

### zkFi

zkFi was an academic project proposing a multi-asset privacy pool for EVM DeFi. Their key innovation was using stateless proxy contracts — the privacy pool doesn't interact with Aave directly; instead, stateless proxy contracts route funds through Aave while maintaining user anonymity.

**Their circuit architecture** (from the [zkFi paper](https://arxiv.org/html/2307.00521v4)):
- Notes: each deposit creates a "note" containing (amount, asset, secret, nullifier)
- The note hash goes into a Merkle tree (same as Tornado Cash)
- Withdrawal proves Merkle membership + nullifier reveal

This note structure is directly adopted in ShieldLend. The `withdraw.circom` constraint structure follows the zkFi paper's approach.

**Why it didn't ship**: Academic research project — the paper is the artifact, not a deployed product.

**What ShieldLend takes from it**: Circuit architecture reference, particularly the multi-asset note design and the proof structure for Merkle membership with nullifier binding.

---

### Zkredit

Zkredit is building private DeFi lending on Solana using MPC (Multi-Party Computation) rather than ZK proofs. Multiple computing nodes jointly compute on encrypted data without any single node seeing the full picture.

**Why they chose MPC over ZK**:
> "ZK proofs were too slow and too expensive to verify on Solana for this use case."

**What ShieldLend takes from it**: This is the strongest argument *for* zkVerify. The objection that killed ZK for Zkredit (verification cost) is directly addressed by zkVerify's 91% cost reduction. On EVM chains with zkVerify, ZK is now economically viable for exactly the use case Zkredit needed MPC for.

---

### Aztec Connect

Aztec Connect was Aztec's attempt to bring privacy to Ethereum DeFi. Users interacted with L1 DeFi protocols (Aave, Lido, Curve) through encrypted Aztec transactions batched into a rollup. The system worked — users could privately supply to Aave — but it was shut down in March 2023.

**Why it was shut down**:
- Extreme engineering complexity: a full privacy L2 with custom transaction format, custom proof system (PLONK-based), and custom sequencer
- Small team maintaining a very large system
- The regulatory environment post-Tornado Cash made privacy tooling difficult to operate

**What ShieldLend learns from it**: Feature-level privacy (adding ZK proofs to specific lending actions) is far more tractable than full-system privacy (encrypting all transactions at the L2 level). ShieldLend adds privacy where it matters most (deposit/withdrawal unlinkability) without trying to hide everything.

---

## ShieldLend's Differentiation

```
Sacred Finance proved:   "Tornado Cash pattern + lending yield = viable concept"
Aztec Connect proved:    "Full privacy L2 = too complex, team burned out"
Zkredit showed:          "ZK verification cost was the blocker → zkVerify solves this"
zkFi gave us:            Circuit architecture reference for multi-asset notes

ShieldLend = proven pattern (Tornado Cash / Sacred Finance)
           + proven lending mechanic (Aave V3 fork)
           + cost problem solved (zkVerify — 91% cheaper verification)
           + right-scoped complexity (feature-level privacy, not full L2)
           + novel chain combination (Horizen L3 on Base — not tried before)
```

The gap ShieldLend fills: no project has combined the Tornado Cash privacy pattern with DeFi lending mechanics on a privacy-native EVM chain with cheap modular proof verification. Sacred Finance was the closest, but ran on expensive Ethereum L1 without zkVerify.
