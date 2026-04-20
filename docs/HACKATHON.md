# ShieldLend — Hackathon Submission Guide

**Event**: Colosseum Frontier Hackathon 2026

ShieldLend targets three tracks simultaneously. Each track covers an orthogonal privacy layer — there is no overlap in the features claimed for each.

---

## Track Overview

| Track | Sponsor | Prize | Deadline | Privacy layer |
|---|---|---|---|---|
| IKA + Encrypt Frontier | Superteam | $15,000 USDC | Jun 1 | Authorization + data confidentiality |
| Colosseum Privacy Track | MagicBlock | $5,000 + $250K accelerator | May 27 | Execution environment + randomness + UX |
| Umbra Side Track | Frontier | $10,000 USDC | May 26 | Output address privacy |

---

## Track 1 — IKA + Encrypt Frontier ($15,000 USDC)

### Track theme
"Bridgeless Capital Markets + Encrypted Capital Markets"

### IKA integration points (4)

**1. dWallet relay (deposit + repay)**
The protocol relay wallet is a 2PC-MPC dWallet. Every deposit and repayment routed through the relay requires both:
- User partial signature (consent gate)
- IKA MPC network co-signature (policy gate)

No single party — including the protocol deployer — can move user funds through the relay unilaterally. This eliminates the single operator key risk that makes most DeFi relay designs unauditable.

**2. dWallet disbursement signing (borrow)**
Loan disbursements are co-signed via `approve_message()` CPI. The LendingPool program enforces LTV rules; the IKA MPC network enforces that the user consented to the specific disbursement parameters (amount, recipient, loanId). Both gates must pass for funds to leave ShieldedPool.

**3. FutureSign (pre-authorized liquidation)**
At borrow time, the borrower pre-signs a conditional liquidation authorization: "liquidate loanId X if health_factor < Y." This consent is stored in the IKA dWallet. When the ER bot detects a health factor breach, the pre-authorization completes without requiring the borrower to be online and without operator discretion.

The design property: liquidation is trustless consent, not operator permission.

**4. ReEncryptShare (protocol upgrade path, deferred)**
Future DAO governance: admin key transfer without requiring the IKA MPC network to reshare secrets. Deferred to post-mainnet when IKA Solana mainnet is available.

### Encrypt integration points (4)

**1. FHE loan balance accounts**
Every `LoanAccount` PDA stores `encrypted_balance` and `encrypted_interest` as Encrypt FHE ciphertexts. Validators executing the Anchor program can call the `accrue_interest` function — which runs homomorphically on ciphertexts — without ever seeing a plaintext amount.

**2. Encrypted oracle input (price feeds)**
Liquidation requires knowing the market price of SOL relative to the loan's collateral denomination. Price feeds are submitted as FHE ciphertext inputs. The health_factor computation runs on encrypted oracle data — MEV bots cannot front-run liquidations by observing incoming price updates.

**3. Aggregate solvency check (homomorphic sum)**
The ER liquidation bot continuously monitors: Σ(encrypted_balance[i]) ≤ shielded_pool.lamports × LTV_FLOOR. The sum is computed via FHE homomorphic addition — individual positions remain hidden. A single threshold decrypt reveals only the aggregate total outstanding. This is the privacy-preserving version of a solvency reserve ratio check.

**4. Targeted threshold decryption (auditor disclosure)**
For compliance disclosure of a specific loan, a 2/3 IKA MPC threshold decryption reveals the amount for that loanId to the designated auditor. Individual borrower identity is not revealed — only the amount. This satisfies "selective disclosure to regulator" requirements without a backdoor key.

### Why IKA and Encrypt are not competing

IKA provides signing authorization infrastructure. Encrypt provides FHE computation infrastructure. Encrypt uses IKA as its coordination layer — they are architecturally layered, not competing. ShieldLend uses IKA for relay signing and IKA for threshold decryption coordination (which Encrypt relies on). The two integrations are complementary.

---

## Track 2 — Colosseum Privacy Track — MagicBlock ($5,000 + $250K accelerator)

### Track theme
"Privacy infrastructure for DeFi — execution environment, randomness, and session UX"

### MagicBlock integration points (5)

**1. Private Ephemeral Rollup (PER) — deposit batching**
ShieldedPool deposit queue accounts are delegated to the MagicBlock PER. The PER runs inside an Intel TDX enclave — deposit batching occurs inside the enclave, and no observer (including the PER operator) can link an individual user's funding transaction (TX1) to their commitment in the batch (TX2).

This is the core deposit privacy mechanism. Without PER, the relay design would only route funding through a different wallet — an observer could still time-correlate TX1 and TX2 for a single depositor. PER's enclave prevents this even for a 1-user batch.

Integration: `#[ephemeral]` and `#[delegate]` macros on DepositQueueAccount; `#[commit]` on flush_epoch.

**2. VRF — anonymity set expansion**
At epoch flush, dummy commitments are inserted into the Merkle tree using MagicBlock VRF randomness. The VRF proof is included in the flush_epoch transaction and verifiable on-chain — no one, including the flush operator, can predict or bias the number or positions of dummy insertions.

This is why ring proof unlinkability holds even as the pool grows: dummy commitments are real Merkle leaves, indistinguishable from depositor commitments, and they expand the anonymity set for all future ring constructions.

Integration: VRF SDK callback wired to `flush_epoch`.

**3. Session Keys — single-authorization UX**
Users authorize a session keypair once via their Phantom/Backpack wallet. The Session Token PDA scopes the keypair to specific operations (auto-sweep, note vault, monitoring). Secondary operations run automatically without wallet prompts.

This is necessary for the MagicBlock Magic Actions automation: the sweep transaction triggered by a PER commit needs to sign automatically without requiring the user to be present at commit time.

Integration: `@magicblock/session-keys` in frontend; session token checked in relevant CPI paths.

**4. Magic Actions — automated post-commit sweep**
When the PER commits a deposit batch to base Solana, a Magic Action fires: the Umbra SDK sweep for completed deposits triggers automatically. Users do not need to poll for PER commit confirmation or manually initiate their stealth address sweep.

This closes the automation loop: Deposit → PER batch → Commit → Magic Action → Umbra sweep → User wallet. Zero manual steps after the initial deposit.

Integration: Magic Action defined on ShieldedPool commit event; references Umbra SDK sweep transaction.

**5. Ephemeral Rollup (ER) — liquidation monitoring**
LendingPool health monitor state is delegated to a standard (non-private) ER. The ER runs at 1ms block time — health factor checks run continuously. Liquidation triggers commit to base Solana atomically after health_factor breach confirmation.

This eliminates the MEV front-running window. On base-layer Solana (400ms blocks), there is a ~400ms window where a liquidation condition exists but no transaction has been submitted — enough for MEV bots to observe and front-run. ER's 1ms block time closes this window.

Integration: `#[delegate]` on health monitor state; liquidation instruction dispatched from ER to base layer.

---

## Track 3 — Umbra Side Track ($10,000 USDC)

### Track theme
"Stealth addresses as the unified output privacy layer for DeFi"

### Umbra integration points

**1. Withdrawal destinations**
Every ShieldedPool withdrawal routes to a fresh Umbra stealth address. The address is generated via Umbra SDK from the recipient's published stealth meta-address. Only the recipient can derive the private key via ECDH. The stealth address has zero prior chain history — no observer can link it to the recipient's primary wallet. After the SDK sweeps funds to the user's wallet, the stealth address is abandoned and never reused.

**2. Loan disbursement destinations**
Every borrow disbursement routes to a fresh Umbra stealth address. The borrower's wallet address is a private input to the collateral_ring ZK circuit — never published on-chain. The only on-chain disbursement target is a freshly generated Umbra stealth address. This breaks the chain: collateral commitment → loan disbursement → borrower identity.

**3. Payroll → ShieldLend privacy chain**
ShieldLend documents and implements the complete privacy chain for Umbra payroll recipients:

```
Employer → Umbra.sendToStealthAddress(employeeMetaAddress, SOL)
  → Salary arrives at one-time stealth address
Employee → Umbra SDK sweeps to ShieldLend deposit relay
  → ShieldLend deposit: commitment generated, note saved locally
  → Earns yield on pooled SOL
  → Can borrow against deposited collateral

Result: Employer never sees where salary was allocated.
        ShieldLend never sees the payroll origin.
        Privacy chain intact end-to-end.
```

This is the most complete expression of Umbra's payroll privacy use case: funds never touch the employee's primary wallet between payroll receipt and productive on-chain deployment.

### Submission narrative

ShieldLend replaces every ad-hoc stealth address implementation in a lending protocol with Umbra SDK. All stealth operations — withdrawal, borrow disbursement, and payroll-to-deposit flows — use Umbra's scheme consistently, ensuring the same key derivation, address generation, and sweep behavior throughout.

The payroll use case is novel: it demonstrates that a user can receive salary, deploy it productively (earn yield, borrow), and never expose their primary wallet as an intermediary in the chain. Umbra is the privacy layer that makes this possible.

---

## Why Three Tracks Are Non-Overlapping

Each track is awarded for a distinct privacy dimension:

| Privacy dimension | Layer | Track |
|---|---|---|
| Who signed and authorized the relay operation | Authorization | IKA + Encrypt Frontier |
| What amounts are stored on-chain | Data confidentiality | IKA + Encrypt Frontier |
| Where deposit→commitment mapping can be observed | Execution environment | Colosseum / MagicBlock |
| Whether dummy insertions are biasable | Randomness | Colosseum / MagicBlock |
| Where funds go after withdrawal or disbursement | Address privacy | Umbra Side Track |

No single feature is claimed for multiple tracks. The IKA/Encrypt track is about signing trust and encrypted state. The MagicBlock track is about execution privacy and automation. The Umbra track is about address-layer privacy. These are three layers of the same protocol stack.

---

## Integration Pre-Requisites

| Integration | Action required before coding |
|---|---|
| MagicBlock PER | Join Discord (discord.com/invite/MBkdC3gxcv), request devnet PER endpoint in developer channel |
| IKA dWallet | Access IKA devnet; `ika-dwallet-anchor` Rust crate; pre-alpha — mock signer for hackathon |
| Encrypt FHE | Access Encrypt devnet; `encrypt-anchor` crate; pre-alpha — plaintext fallback for hackathon |
| Umbra SDK | Solana mainnet alpha via Arcium (Feb 2026); stealthaddress.dev SDK docs |
| groth16-solana | `groth16-solana` crate from Light Protocol; Solana 1.18.x+ |
