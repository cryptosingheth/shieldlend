# ShieldLend — Hackathon Track Integrations

**Event**: Colosseum Frontier Hackathon 2026

ShieldLend targets three tracks simultaneously. Each track covers an orthogonal privacy layer — there is no overlap in the features claimed for each.

---

## Track Overview

| Track | Sponsor | ShieldLend implements |
|---|---|---|
| IKA + Encrypt Frontier | Superteam | dWallet relay (deposit + withdrawal + repay) + dWallet disbursement co-signing + FutureSign liquidation + FHE oracle encryption + FHE aggregate solvency + threshold compliance disclosure |
| Colosseum Privacy Track | MagicBlock | PER deposit batching + PER exit batching + VRF dummy insertion |
| Umbra Side Track | Frontier | Umbra SDK for all output addresses (withdrawals + loan disbursements) |

---

## Track 1 — IKA + Encrypt Frontier

### Track theme
"Bridgeless Capital Markets + Encrypted Capital Markets"

### IKA integration points (3)

**1. dWallet relay (deposit + withdrawal + repay)**
The protocol relay wallet is a 2PC-MPC dWallet. Every deposit, withdrawal, and repayment submitted on-chain goes through this relay. Each operation requires both:
- User partial signature (consent gate)
- IKA MPC network co-signature (policy gate)

No single party — including the protocol deployer — can move user funds through the relay unilaterally. The relay wallet is the permanent on-chain signer for all ShieldedPool and LendingPool transactions. User wallets never appear in any on-chain transaction touching the protocol.

**2. dWallet disbursement signing (borrow)**
Loan disbursements are co-signed via `approve_message()` CPI. The LendingPool program enforces LTV rules on-chain via Groth16 verification; the IKA MPC network enforces that the user consented to the specific disbursement parameters (amount, recipient, loanId). Both gates must pass for funds to leave ShieldedPool.

**3. FutureSign (pre-authorized liquidation)**
At borrow time, the borrower pre-signs a conditional liquidation authorization: "liquidate loanId X if health_factor < Y." This consent is stored in the IKA dWallet. When the health factor condition is met, the pre-authorization executes without requiring the borrower to be online and without operator discretion.

The design property: liquidation is trustless consent, not operator permission.

### Encrypt integration points (3)

**1. FHE oracle input (price feeds)**
Liquidation requires knowing the market price of SOL relative to the loan's collateral denomination. Price feeds are submitted as Encrypt FHE ciphertext inputs. The health_factor computation runs homomorphically on encrypted oracle data — MEV bots cannot compute the health factor breach condition from encrypted mempool data.

ZK proofs can verify a fact about a known value, but cannot receive a continuously updating oracle stream and compute over it homomorphically. FHE is the only approach that allows real-time encrypted price feeds to feed directly into liquidation logic without plaintext exposure.

**2. Aggregate solvency check (homomorphic sum)**
Total protocol outstanding debt is computed as: `Σ(encrypted_balance[i])` via FHE homomorphic addition. A single threshold decrypt reveals only the aggregate total. Individual positions remain hidden throughout.

This enables protocol solvency verification — confirming total outstanding debt is within the collateral reserve — without exposing any individual borrower's position.

**3. Targeted threshold decryption (auditor disclosure)**
For compliance disclosure of a specific loan, a 2/3 IKA MPC threshold decryption reveals the outstanding balance for that loanId to the designated auditor. Individual borrower identity is not revealed — only the amount. This satisfies selective disclosure requirements without a backdoor key.

### Why IKA and Encrypt are not competing

IKA provides signing authorization infrastructure. Encrypt provides FHE computation infrastructure. Encrypt uses IKA as its coordination layer for threshold decryption. ShieldLend uses IKA for relay signing and for coordinating threshold decryption (which Encrypt relies on). The two integrations are architecturally layered, not competing.

---

## Track 2 — Colosseum Privacy Track — MagicBlock

### Track theme
"Privacy infrastructure for DeFi — execution environment and randomness"

### MagicBlock integration points (3)

**1. Private Ephemeral Rollup (PER) — deposit batching**
ShieldedPool deposit queue accounts are delegated to the MagicBlock PER. The PER runs inside an Intel TDX enclave — deposit batching occurs inside the enclave, and no observer (including the PER operator) can link an individual user's funding transaction (TX1) to their commitment in the batch (TX2).

This is the core deposit timing-correlation defense. Without PER, the relay design would route funding through a different wallet — but an observer could still time-correlate TX1 and TX2 for a single depositor. PER's enclave prevents this even for a 1-user batch.

Integration: `#[ephemeral]` and `#[delegate]` macros on DepositQueueAccount; `#[commit]` on flush_epoch.

**2. Private Ephemeral Rollup (PER) — exit batching**
ShieldedPool exit queue accounts are also delegated to the MagicBlock PER. Both withdrawal exits and borrow disbursement exits enqueue as `ExitQueueAccount` entries in the same PER enclave. The `flush_exits` instruction sends each amount to its respective Umbra stealth address in a single batch.

This makes withdrawal and borrow disbursement exits structurally indistinguishable on-chain. An observer sees: "relay sent SOL to stealth addresses." The type of exit — withdrawal or borrow disbursement — cannot be classified. Without exit batching, the different on-chain instruction names (`withdraw` vs `disburse`) would reveal which type of exit occurred.

Integration: `#[delegate]` on ExitQueueAccount; `flush_exits` commits from PER to base layer.

**3. VRF — anonymity set expansion**
At epoch flush, dummy commitments are inserted into the Merkle tree using MagicBlock VRF randomness. The VRF proof is included in the flush_epoch transaction and verifiable on-chain — no one, including the flush operator, can predict or bias the number or positions of dummy insertions.

VRF runs once per deposit epoch. The resulting dummy commitments persist in the Merkle tree permanently and are indistinguishable from real commitments. Every future ring proof — for withdrawal, borrow, or repay — samples its K=16 ring from the full tree, which includes all VRF-placed dummies. Anonymity set expansion from VRF carries forward automatically into every ring proof, with no additional VRF calls required at spend time.

Integration: VRF SDK callback wired to `flush_epoch`.

---

## Track 3 — Umbra Side Track

### Track theme
"Stealth addresses as the unified output privacy layer for DeFi"

### Umbra integration points (2)

**1. Withdrawal destinations**
Every ShieldedPool withdrawal routes to a fresh Umbra stealth address. The address is generated via Umbra SDK from the recipient's published stealth meta-address. Only the recipient can derive the private key via ECDH. The stealth address has zero prior chain history — no observer can link it to the recipient's primary wallet.

**2. Loan disbursement destinations**
Every borrow disbursement routes to a fresh Umbra stealth address. The borrower's wallet address is a private input to the collateral_ring ZK circuit — never published on-chain. The only on-chain disbursement target is a freshly generated Umbra stealth address. This breaks the on-chain chain: collateral commitment → loan disbursement → borrower identity.

Both exits — withdrawal and disbursement — use the same Umbra scheme and route through the same PER exit batch. The unified stealth address format is a prerequisite for exit batching to be effective: both exit types must look identical on-chain to be indistinguishable.

---

## Why Three Tracks Are Non-Overlapping

Each track is awarded for a distinct privacy dimension:

| Privacy dimension | Layer | Track |
|---|---|---|
| Who signed and authorized each on-chain relay operation | Authorization | IKA + Encrypt Frontier |
| Oracle data and aggregate balances confidentiality | Data confidentiality | IKA + Encrypt Frontier |
| Where deposit→commitment mapping can be observed | Execution environment | Colosseum / MagicBlock |
| Whether dummy insertions are biasable | Randomness | Colosseum / MagicBlock |
| What exit type (withdrawal vs disbursement) can be inferred | Exit classification | Colosseum / MagicBlock |
| Where funds go after withdrawal or disbursement | Address privacy | Umbra Side Track |

No single feature is claimed for multiple tracks. The IKA/Encrypt track is about signing trust and encrypted computation. The MagicBlock track is about execution privacy, temporal batching, and randomness. The Umbra track is about address-layer output privacy. These are three layers of the same protocol stack.

---

## Integration Pre-Requisites

| Integration | Action required before coding |
|---|---|
| MagicBlock PER | Join Discord (discord.com/invite/MBkdC3gxcv), request devnet PER endpoint in developer channel |
| IKA dWallet | Access IKA devnet; `ika-dwallet-anchor` Rust crate; pre-alpha — mock signer for hackathon |
| Encrypt FHE | Access Encrypt devnet; `encrypt-anchor` crate; pre-alpha — plaintext fallback for hackathon |
| Umbra SDK | Solana mainnet alpha via Arcium (Feb 2026); stealthaddress.dev SDK docs |
| groth16-solana | `groth16-solana` crate from Light Protocol; Solana 1.18.x+ |
