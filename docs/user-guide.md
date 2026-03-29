# ShieldLend — User Guide
**Private DeFi Lending on Base Sepolia + zkVerify**

---

## What is ShieldLend?

ShieldLend lets you deposit ETH, borrow against it, or withdraw it — without anyone being able to link your deposit address to your withdrawal address. It uses **Zero-Knowledge Proofs** to prove you own funds without revealing which deposit is yours.

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
2. Enter an amount (e.g. `0.005`)
3. Click **Deposit**
4. A **note** will appear on screen — **SAVE THIS IMMEDIATELY**

The note looks like:
```json
{
  "nullifier": "154c946e...",
  "secret": "20dea7c6...",
  "amount": "5000000000000000",
  "commitment": "4e9db174...",
  "nullifierHash": "24fe14ad..."
}
```

**This note IS your funds.** Save it to a text file. Losing it means losing access to the ETH permanently.

5. MetaMask will pop up — confirm the transaction
6. Wait for "Deposit confirmed"

What happened on-chain: your `commitment` (a hash of your note) was inserted into a Merkle tree inside `ShieldedPool.sol`. Your real deposit data stays private.

---

### Step 3: Withdraw ETH

You can withdraw to **any address** — it will have no on-chain link to the original depositor.

1. Go to the **Withdraw** tab
2. Paste your saved note JSON into the "Note" field
3. Enter the **recipient address** (can be a completely different wallet)
4. Click **Withdraw**

The app will:
- Fetch the Merkle path (which position in the tree your deposit occupies) — ~2 seconds
- Generate a ZK proof in your browser — ~5-10 seconds
- Submit the proof to zkVerify for verification — ~10-20 seconds
- Call the withdraw function on-chain — MetaMask popup appears
- Confirm and send funds to recipient

5. Wait for "Withdrawal confirmed"

**Privacy guarantee:** Anyone watching the blockchain sees a withdrawal from the ShieldedPool contract, but cannot determine which of the many deposits it came from.

---

### Step 4: Borrow Against Collateral *(Coming Soon)*

The Borrow tab lets you use your shielded deposit as collateral for a loan, without revealing your deposit amount. Currently under testing.

---

## Frequently Asked Questions

**Q: What if I lose my note?**
A: The funds are permanently inaccessible. There is no recovery mechanism — this is by design for privacy. Always back up your note.

**Q: Can I send to my own address?**
A: Yes, but it defeats the privacy purpose. The power of ShieldLend is withdrawing to a fresh address with no transaction history.

**Q: Why does it take ~30 seconds?**
A: Your browser is generating a cryptographic proof (Zero-Knowledge Proof) that mathematically proves you deposited the funds, without revealing which deposit is yours. This computation is done entirely on your device.

**Q: Is my nullifier and secret safe to share?**
A: **Never share them.** Anyone with your `nullifier` and `secret` can drain your funds. Only the `commitment` and `nullifierHash` are safe to show publicly (they're already on-chain).

---

## Glossary

| Term | Plain English Meaning |
|------|-----------------------|
| **Note** | Your private receipt — like a claim ticket for your deposit |
| **Nullifier** | A secret number that, when spent, prevents double-withdrawals |
| **Commitment** | A public fingerprint of your note that goes on-chain |
| **Merkle Tree** | A data structure that lets you prove "my deposit is in this pool" with minimal data |
| **ZK Proof** | Mathematical proof that you know something (your note) without revealing what it is |
| **zkVerify** | A blockchain service that verifies ZK proofs and stamps them with an on-chain attestation |
| **Nullifier Hash** | Public record that this deposit has been withdrawn — prevents withdrawing twice |
