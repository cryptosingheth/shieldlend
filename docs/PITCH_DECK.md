# ShieldLend Solana — Pitch Deck Narrative

This is the source narrative for the investor / mentor / judge deck. The editable PPTX artifact is generated at [`docs/pitch_deck/ShieldLend_Pitch_Deck.pptx`](pitch_deck/ShieldLend_Pitch_Deck.pptx), with previews under [`docs/pitch_deck/previews/`](pitch_deck/previews/).

---

## Slide 1 — ShieldLend

Privacy-first lending on Solana.

One-line story: users can deposit, borrow, repay, withdraw, and selectively disclose history without exposing their wallet-level credit profile on-chain.

---

## Slide 2 — The Problem

DeFi lending is financially transparent in the wrong places.

Public chains reveal:
- who deposited,
- who borrowed,
- how much they borrowed,
- when they repaid,
- where funds went,
- and which wallets are likely controlled by the same entity.

This blocks institutions, payroll users, treasury desks, and privacy-sensitive individuals from using lending protocols safely.

---

## Slide 3 — Why Existing Solutions Are Incomplete

Mixers, stealth addresses, encrypted oracles, and ZK proofs each solve one part of the problem.

None of them alone provides full transaction lifecycle privacy for lending:
- mixers do not provide borrow/repay/lend state,
- stealth addresses do not hide deposits or loan state,
- ZK proofs do not hide a normal public token transfer,
- FHE computation does not solve address-level linkability.

ShieldLend combines the layers deliberately.

---

## Slide 4 — The ShieldLend Stack

| Layer | Privacy gap closed |
|---|---|
| IKA dWallet | no single relay key; user wallet not transaction signer |
| MagicBlock PER | deposit and exit timing unlinkability |
| Groth16 circuits | note ownership and collateral checks without revealing note identity |
| MagicBlock Private Payments | full privacy repayment settlement |
| Encrypt FHE | encrypted oracle/health computation and aggregate collateral coverage |
| Umbra | one-time withdrawal and disbursement addresses |

Each protocol has a separate technical reason to exist in the architecture.

---

## Slide 5 — What Users Can Do

1. Deposit fixed-denomination SOL into a shielded pool.
2. Borrow against a hidden collateral note.
3. Receive funds at a fresh stealth address.
4. Repay through a private payment settlement path.
5. Withdraw collateral through a ring proof.
6. Export selected history records only when needed.

---

## Slide 6 — The Lending Mechanics Are Conservative

MVP does not compromise safety for novelty.

Design choices:
- Kamino-style poly-linear interest model.
- Public or bucketed borrow amount for deterministic LTV and liquidation.
- Full liquidation only for MVP.
- Conservative LTV and minimum borrow size.
- Stale-oracle pause and breach confirmation.
- Explicit reserve and bad-debt accounting.

Privacy is added around lending mechanics, not instead of them.

---

## Slide 7 — Privacy Claims, Precisely

ShieldLend hides:
- depositor wallet to commitment,
- borrower wallet to loan,
- collateral note identity,
- withdrawal and disbursement destination identity,
- repayment transfer graph in Full Privacy mode,
- oracle/health computation from MEV.

ShieldLend intentionally discloses:
- that a loan exists,
- public or bucketed borrow amount,
- protocol-level aggregate state.

This avoids overclaiming and keeps the lending system verifiable.

---

## Slide 8 — Competitive Landscape

| Category | Examples | Gap |
|---|---|---|
| General privacy pools | Tornado Cash, Railgun, Elusiv | no lending state machine |
| Stealth address tools | Umbra-style systems | hide destination only |
| FHE lending prototypes | Laolex/shieldlend-style designs | limited Solana-native UX and address privacy |
| ZK credit projects | AXIS-style tiering | scoring, not full private lending lifecycle |

ShieldLend is positioned as private lending infrastructure, not only a mixer or wallet privacy tool.

---

## Slide 9 — Why Solana

Solana makes the UX viable:
- low-cost transactions,
- fast confirmations,
- Anchor account model for PDA state,
- native Groth16 verification path via `groth16-solana`,
- sponsor ecosystem around PER, FHE, dWallets, and stealth addresses.

The protocol can feel like a normal lending app while enforcing privacy behind the scenes.

---

## Slide 10 — Demo Story

Demo sequence:
1. Deposit into shielded pool.
2. Show batch commitment and note saved locally.
3. Borrow from hidden collateral note.
4. Show loan appears publicly but borrower identity is absent.
5. Repay with private payment receipt.
6. Unlock collateral.
7. Show local encrypted history and scoped disclosure export.

---

## Slide 11 — Roadmap

Hackathon MVP:
- Anchor program skeletons,
- updated circuits,
- private repayment receipt binding,
- MagicBlock/IKA/Encrypt/Umbra adapters,
- local history and disclosure UX,
- visual docs and demo flow.

Post-MVP:
- partial liquidation,
- encrypted borrow amount research,
- dummy LoanAccount PDAs,
- proof of innocence,
- ZK credit tier attestations.

---

## Slide 12 — Ask

We are looking for:
- technical mentorship on Solana privacy integrations,
- protocol partner support for devnet access,
- lending risk feedback,
- pilot users who need private treasury or credit activity.

The thesis: private lending will not be one primitive. It needs a coordinated stack that preserves both financial safety and user-level privacy.
