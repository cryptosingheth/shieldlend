# ShieldLend — User Guide
**Private DeFi Lending on Base Sepolia + zkVerify**

---

## What is ShieldLend?

ShieldLend lets you deposit ETH, borrow against it, repay, and withdraw — without anyone being able to link your deposit address to your withdrawal address. It uses **Zero-Knowledge Proofs** to prove you own funds without revealing which deposit is yours.

**Think of it like this:** Imagine depositing cash into a sealed envelope at a bank, and later withdrawing the same amount from a different branch — with no record linking you to the original deposit. That's what ShieldLend does, on a blockchain.

---

## How to Use ShieldLend

### Before You Start
- Install MetaMask: https://metamask.io
- Add Base Sepolia network to MetaMask:
  - Network name: **Base Sepolia**
  - RPC URL: `https://sepolia.base.org`
  - Chain ID: **84532**
  - Currency symbol: ETH
- Get testnet ETH: https://www.alchemy.com/faucets/base-sepolia
- Open the app at http://localhost:3000 (or deployed URL)

---

### Step 1: Connect Wallet
Click **Connect Wallet** in the top right. Approve in MetaMask.

If you see a red banner saying "Wrong network", click **Switch to Base Sepolia**.

---

### Step 2: Deposit ETH

1. Go to the **Deposit** tab
2. Enter an amount (fixed denominations only — e.g. `0.0001 ETH`)
3. Click **Deposit**
4. MetaMask will pop up — confirm the transaction
5. Wait for "Deposit confirmed"

After confirmation you'll see a success banner: **"Deposit confirmed — note saved to vault."**

Your note (the cryptographic receipt for your deposit) is automatically encrypted and saved to your browser's local vault using your MetaMask wallet signature as the key. **No JSON to paste or save manually.**

> **Important:** Your note is encrypted with your wallet signature. Switching wallets or clearing browser storage means you lose access to notes for that wallet. Consider exporting your vault from settings for backup.

**What happens on-chain:** Your commitment (a hash of your note) enters a deposit queue. It will be shuffled into the Merkle tree during the next epoch flush (~50 blocks / ~2 minutes on Base Sepolia).

---

### Step 3: Wait for the Epoch Flush

ShieldLend deposits are **batched for privacy**. Instead of inserting each deposit individually (which would link timing to users), deposits are held in a queue and inserted together with dummy entries once every 50 blocks.

When you go to the **Withdraw** tab and select your note, you'll see one of two states:

- **Indigo banner — "Waiting for epoch flush (~N blocks remaining)"**: Your deposit is in the queue but not yet in the Merkle tree. The Withdraw button is disabled.
- **No banner / green state**: Your note is in the Merkle tree and can be withdrawn.

> **This wait is by design.** The epoch flush is what provides the anonymity set — your deposit is mixed with others (and dummy entries) before entering the tree.

---

### Step 4: Withdraw ETH

You can withdraw to **any address** — it will have no on-chain link to the original depositor.

1. Go to the **Withdraw** tab
2. Select your note from the dropdown
3. Enter the **recipient address** (can be any wallet — even one you've never used before)
4. Click **Withdraw**

The app will:
- **MetaMask pop-up #1**: Flush the epoch (if not already flushed) — inserts your batch into the Merkle tree
- Immediately after flush confirms: generate a ZK proof in your browser — **~25 seconds**
- Submit the proof to **zkVerify** for verification — ~30–60 seconds
- **MetaMask pop-up #2**: Send the on-chain withdrawal transaction
- Confirm and send funds to recipient

5. Wait for "Withdrawal confirmed"

**Privacy guarantee:** Anyone watching the blockchain sees a withdrawal from the ShieldedPool contract, but cannot determine which of the many deposits it came from.

> **Ring proofs (K=16):** Your deposit is proven as a member of a ring of 16 commitments. Even if an observer knows all 16 ring members, they cannot determine which one is yours without your `secret` and `nullifier`.

---

### Step 5: Borrow Against a Shielded Note

You can use a note that's been flushed into the Merkle tree as **private collateral** for a loan.

1. Go to the **Borrow** tab
2. Select your note from the **Collateral Note** dropdown (only Merkle-flushed notes appear)
3. Enter the borrow amount
4. The **health factor** is shown automatically — must be ≥ 110% to proceed
5. Click **Borrow**

The app will:
- Fetch the Merkle inclusion path for your note
- Generate a ZK collateral proof — **~25 seconds**
- Submit to zkVerify
- Send the `borrow()` transaction

After the tx confirms, the borrowed ETH arrives at your specified recipient address and the loan appears in the **Repay** section below.

> **Collateral is locked.** While a loan is open, the collateral note cannot be withdrawn until the loan is repaid (or liquidated).

#### Health Factor & LTV

ShieldLend requires **collateral ≥ 110% of borrowed amount** at borrow time. The denomination of your shielded note is the private collateral amount — it is never revealed on-chain, only proven in zero-knowledge.

Liquidation triggers if the outstanding debt (principal + accrued interest) exceeds 90% of the collateral amount.

---

### Step 6: Repay a Loan

1. Go to the **Borrow** tab, scroll to **Repay**
2. Select your loan from the dropdown — shows `Loan #N · [note label] · X.XXXX ETH owed`
3. Click **Repay**

The app reads the current `totalOwed` (principal + accrued interest) immediately before sending the transaction, so the amount is always fresh. Any overpayment is automatically refunded by the contract.

After repay confirms, your collateral note is unlocked and can be withdrawn normally.

---

## Interest Rate Model

ShieldLend uses an **Aave v3-style two-slope utilization model**:

| Utilization | Rate formula |
|-------------|-------------|
| ≤ 80% | 1% base + (util / 80%) × 4% |
| > 80% | 5% + ((util − 80%) / 20%) × 40% |

Interest accrues per second (based on `block.timestamp`). The current rate depends on how much of the pool is borrowed at any given time.

---

## Frequently Asked Questions

**Q: What if I lose access to my notes?**
A: Notes are encrypted in your browser's local storage with your MetaMask wallet signature. Connecting the same wallet on the same browser recovers all notes. On a new device, connect the same wallet — notes won't be there unless you export and import the vault file.

**Q: Can I send to my own address?**
A: Yes, but it reduces privacy. The power of ShieldLend is withdrawing to a fresh address with no transaction history linking it to your depositing address.

**Q: Why does it take ~25 seconds to generate the proof?**
A: Your browser is running a Groth16 circuit with ~24k constraints, using a ring of 16 commitments and a 24-level Merkle tree. The proof is generated entirely on your device — nothing leaves your browser.

**Q: Why do I have to wait ~50 blocks before withdrawing?**
A: The epoch flush is the privacy mechanism. Your deposit sits in a queue with others. When the flush fires, it shuffles the queue using `prevrandao` and inserts dummy entries — so even a blockchain observer can't tell which leaf is yours just from insertion timing.

**Q: Is my nullifier and secret safe to share?**
A: **Never share them.** Anyone with your `nullifier` and `secret` can drain your funds. The `commitment` and `nullifierHash` are already on-chain and safe to discuss publicly.

**Q: Can I borrow before the epoch flush?**
A: No. Borrowing requires a Merkle inclusion proof, which requires your deposit to be in the tree. Wait for the epoch flush first.

---

## Glossary

| Term | Plain English Meaning |
|------|-----------------------|
| **Note** | Your private receipt — a (secret, nullifier, amount) triple that proves ownership of a deposit |
| **Vault** | Browser-side encrypted storage for your notes, locked to your MetaMask wallet |
| **Commitment** | `Poseidon(secret, nullifier)` — the on-chain leaf; reveals nothing about your secret or amount |
| **Nullifier Hash** | `Poseidon(nullifier, ring_index)` — spent when you withdraw; prevents double-withdrawal |
| **Epoch Flush** | 50-block batching window; deposits queued then shuffled into the Merkle tree together |
| **Ring Proof** | Proves your commitment is one of K=16 commitments in a ring, without revealing which one |
| **Merkle Tree** | 24-level binary tree storing all commitments; enables efficient Merkle inclusion proofs |
| **ZK Proof** | Mathematical proof you know (secret, nullifier) for a commitment, without revealing them |
| **zkVerify** | Off-chain proof verification service (Volta testnet); cheaper than on-chain Groth16 verification |
| **Health Factor** | Collateral / debt ratio — must be ≥ 110% to borrow, liquidatable below 90% |
| **Epoch** | A 50-block window after which queued deposits are flushed into the Merkle tree |
