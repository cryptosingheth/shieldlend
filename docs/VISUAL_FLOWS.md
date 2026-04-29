# ShieldLend Solana - Visual Architecture Flows

This file is the plain-English visual explanation of ShieldLend. It is written for judges, mentors, investors, and technical reviewers who need to understand not just which protocols are used, but why each protocol is necessary.

Each flow answers five questions:

1. What is the user trying to do?
2. Which part of ShieldLend checks safety?
3. Which external protocol adds privacy or authorization?
4. What does the public chain still see?
5. What link is broken for observers?

## 1. Protocol Role Map

Purpose: show why each protocol exists in the stack. No protocol is included only for branding; each one closes a separate privacy, safety, or authorization gap.

```mermaid
flowchart LR
    classDef user fill:#f8fafc,stroke:#475569,color:#0f172a
    classDef shield fill:#1e293b,stroke:#475569,color:#e2e8f0
    classDef privacy fill:#0d9488,stroke:#134e4a,color:#fff
    classDef auth fill:#312e81,stroke:#6366f1,color:#fff
    classDef safety fill:#b45309,stroke:#92400e,color:#fff

    User["User app<br/>creates notes, stores history,<br/>builds ZK proofs locally"]:::user
    IKA["IKA dWallet<br/>submits actions without exposing<br/>the user's main wallet"]:::auth
    PER["MagicBlock PER<br/>batches deposits and exits so<br/>timing is harder to link"]:::privacy
    Pay["MagicBlock Private Payments<br/>settles repayment without a normal<br/>public payer-to-vault transfer graph"]:::privacy
    Umbra["Umbra<br/>creates a fresh receiving address<br/>for each withdrawal or loan"]:::privacy
    Encrypt["Encrypt FHE<br/>keeps oracle and health checks<br/>encrypted until authorized reveal"]:::privacy
    SP["shielded_pool<br/>holds SOL and records private<br/>deposit commitments"]:::shield
    LP["lending_pool<br/>checks borrow, repay, interest,<br/>and liquidation rules"]:::safety
    NR["nullifier_registry<br/>marks each note Active, Locked,<br/>or Spent to prevent double use"]:::safety

    User -->|"asks relay to act"| IKA
    IKA -->|"submits batchable actions"| PER
    PER -->|"commits deposits and batches exits"| SP
    SP <-->|"custody and lending checks meet"| LP
    LP -->|"locks, unlocks, or spends notes"| NR
    Pay -->|"returns settlement receipt to verify"| LP
    Encrypt -->|"returns encrypted health evidence"| LP
    SP -->|"sends outputs to fresh addresses"| Umbra
```

What this means: ShieldLend separates responsibilities. ZK proves note ownership, IKA prevents the user's wallet from becoming the protocol signer, MagicBlock hides timing and repayment settlement, Umbra hides output addresses, Encrypt hides liquidation-sensitive data, and the Solana programs enforce lending safety.

## 2. How A Private Deposit Works

Purpose: let a user fund the pool without letting observers map the funding wallet to a specific Merkle commitment.

```mermaid
flowchart TD
    classDef private fill:#0d9488,stroke:#134e4a,color:#fff
    classDef public fill:#334155,stroke:#64748b,color:#fff
    classDef safety fill:#b45309,stroke:#92400e,color:#fff

    A["1. User creates a private note locally<br/>secret + nullifier never leave the app"]:::private
    B["2. App creates a commitment<br/>this becomes the public pool leaf"]:::private
    C["3. User funds the IKA relay<br/>public chain sees only relay funding"]:::public
    D["4. MagicBlock PER waits for a batch<br/>many users enter before pool commit"]:::private
    E["5. VRF plus private enclave entropy adds dummies<br/>observers cannot label real vs dummy leaves"]:::private
    F["6. shielded_pool inserts the batch<br/>Merkle root updates on Solana"]:::public
    G["7. App saves encrypted note backup<br/>user needs this note to withdraw or borrow"]:::private

    A --> B --> C --> D --> E --> F --> G
```

What the chain sees: a relay was funded, then a batch of commitments was inserted.

What privacy is achieved: the chain does not learn which user funding transaction created which commitment. Dummies also make future rings harder to analyze.

What remains verifiable: the pool has received SOL, the Merkle root updated, and each later spend must prove membership in that tree.

## 3. How A Private Withdrawal Works

Purpose: let a user withdraw a note without linking the withdrawal to the original deposit or to a known wallet.

```mermaid
flowchart TD
    classDef private fill:#0d9488,stroke:#134e4a,color:#fff
    classDef public fill:#334155,stroke:#64748b,color:#fff
    classDef safety fill:#b45309,stroke:#92400e,color:#fff

    A["1. User loads encrypted note<br/>only the user knows secret + nullifier"]:::private
    B["2. App builds a ring proof<br/>proves one of K commitments is theirs"]:::private
    C["3. IKA submits the withdrawal<br/>user wallet is not the transaction signer"]:::private
    D["4. shielded_pool verifies Groth16 proof<br/>invalid proofs cannot release funds"]:::safety
    E["5. nullifier_registry marks note Spent<br/>same note cannot withdraw twice"]:::safety
    F["6. MagicBlock PER batches exits<br/>withdrawals mix with borrow disbursements"]:::private
    G["7. Umbra creates a fresh receiving wallet<br/>destination has no prior user history"]:::private
    H["8. User controls that stealth wallet<br/>sweeping to a known wallet can reveal them"]:::private

    A --> B --> C --> D --> E --> F --> G --> H
```

What the chain sees: relay-submitted proof verification, a nullifier marked spent, and a stealth address receiving funds.

What privacy is achieved: the ring hides which commitment was spent, IKA hides which wallet submitted the proof, PER makes exit type harder to classify, and Umbra hides the user's known receiving wallet.

What remains verifiable: the proof is valid, the note was not already spent, and only the fixed denomination is released.

## 4. How Borrowing Works Without Revealing Collateral Identity

Purpose: let a user borrow against a shielded note while keeping the collateral note and borrower wallet unlinked.

```mermaid
flowchart TD
    classDef private fill:#0d9488,stroke:#134e4a,color:#fff
    classDef public fill:#334155,stroke:#64748b,color:#fff
    classDef safety fill:#b45309,stroke:#92400e,color:#fff

    A["1. User selects a note as collateral<br/>selection stays inside the app"]:::private
    B["2. App builds collateral ring proof<br/>proves a valid note supports this loan"]:::private
    C["3. Borrow amount is public or bucketed<br/>needed for LTV, interest, and liquidation"]:::public
    D["4. lending_pool verifies LTV<br/>loan cannot exceed collateral rules"]:::safety
    E["5. nullifier_registry marks note Locked<br/>collateral cannot be withdrawn during loan"]:::safety
    F["6. IKA co-signs disbursement<br/>requires user consent and protocol checks"]:::safety
    G["7. MagicBlock PER batches the loan exit<br/>looks like other pool exits"]:::private
    H["8. Umbra receives loan proceeds<br/>fresh address hides borrower destination"]:::private
    I["9. LoanAccount is created<br/>public loan exists, borrower identity hidden"]:::public

    A --> B --> C --> D --> E --> F --> G --> H
    E --> I
```

What the chain sees: a public or bucketed borrow amount, a LoanAccount PDA, and a locked nullifier.

What privacy is achieved: observers cannot tell which note is collateral, which wallet owns it, or which known address received the loan.

What remains verifiable: the protocol can still enforce LTV, interest, reserves, liquidation, and bad-debt controls.

## 5. How Private Repayment Works

Purpose: repay a loan and unlock collateral without revealing the borrower's wallet, and in Full Privacy mode without exposing a normal public repayment transfer graph.

```mermaid
flowchart TD
    classDef private fill:#0d9488,stroke:#134e4a,color:#fff
    classDef public fill:#334155,stroke:#64748b,color:#fff
    classDef safety fill:#b45309,stroke:#92400e,color:#fff

    A["1. User loads loan and collateral note<br/>wallet identity stays local"]:::private
    B["2. Program computes outstanding balance<br/>public rate history keeps accounting deterministic"]:::public
    C["3. MagicBlock Private Payments settles value<br/>no normal public payer-to-vault path"]:::private
    D["4. Receipt binds exact loan context<br/>loanId + nullifier + balance + vault + nonce"]:::safety
    E["5. App builds repay_ring proof<br/>proves authority over locked collateral note"]:::private
    F["6. IKA submits repay instruction<br/>borrower wallet is not the signer"]:::private
    G["7. lending_pool verifies proof and receipt<br/>collateral unlock requires both"]:::safety
    H["8. nullifier_registry unlocks note<br/>Locked becomes Active"]:::safety
    I["9. User can withdraw collateral privately<br/>normal withdrawal flow applies"]:::private

    A --> B --> C --> D --> E --> F --> G --> H --> I
```

What the chain sees: a loan is repaid and a locked nullifier becomes active again.

What privacy is achieved: the repay transaction does not reveal the borrower's wallet. In Full Privacy mode, MagicBlock Private Payments also avoids a normal visible repayment transfer graph.

What remains verifiable: LendingPool recomputes the outstanding balance, verifies the payment receipt, verifies the ZK proof, and only then unlocks collateral.

Degraded mode: if private payments are unavailable, relay repayment can still hide identity, but repayment amount privacy is not claimed.

## 6. How Liquidation Protects The Protocol

Purpose: prevent bad debt without publicly exposing every borrower's health factor.

```mermaid
flowchart TD
    classDef private fill:#0d9488,stroke:#134e4a,color:#fff
    classDef public fill:#334155,stroke:#64748b,color:#fff
    classDef safety fill:#b45309,stroke:#92400e,color:#fff

    A["1. Oracle price arrives encrypted<br/>MEV bots cannot read health data early"]:::private
    B["2. Encrypt computes health factor<br/>loan health remains ciphertext"]:::private
    C["3. Breach must repeat across epochs<br/>one bad oracle tick is not enough"]:::safety
    D["4. Liquidation reveal is requested<br/>specific LoanAccount handle is snapshotted"]:::public
    E["5. Encrypt threshold reveal confirms result<br/>proof is bound to that LoanAccount PDA"]:::safety
    F{"6. Is loan confirmed unsafe?"}:::safety
    G["7. IKA FutureSign executes consented liquidation<br/>condition was approved at borrow time"]:::safety
    H["8. Full liquidation MVP closes the loan<br/>reserve and bad-debt accounting happen first"]:::safety
    I["9. Collateral nullifier becomes Spent<br/>collateral cannot be reused"]:::safety
    J["Stop: clear pending flags<br/>healthy position cannot be liquidated"]:::safety

    A --> B --> C --> D --> E --> F
    F -->|"yes"| G --> H --> I
    F -->|"no"| J
```

What the chain sees: liquidation requests and confirmations for LoanAccounts.

What privacy is achieved: observers do not get a live public feed of individual health factors or borrower wallets.

What remains verifiable: liquidation only executes after encrypted health computation, threshold confirmation, breach confirmation, and FutureSign conditions pass.

## 7. How User History And Disclosure Work

Purpose: give users records for accounting or compliance without giving the protocol a global viewing key.

```mermaid
flowchart LR
    classDef private fill:#0d9488,stroke:#134e4a,color:#fff
    classDef public fill:#334155,stroke:#64748b,color:#fff
    classDef safety fill:#b45309,stroke:#92400e,color:#fff

    A["User actions<br/>deposit, withdraw, borrow, repay"]:::public
    B["Encrypted local history<br/>stored in the user's app vault"]:::private
    C["User selects records to share<br/>no unrelated notes are revealed"]:::private
    D["Disclosure packet<br/>tx signatures, proof signals, receipt hashes"]:::safety
    E["Auditor verifies selected facts<br/>without protocol-wide deanonymization"]:::public

    A --> B --> C --> D --> E
```

What the user gets: usable transaction history and optional compliance exports.

What the protocol does not get: a user-indexed activity feed, a global viewing key, or a universal deanonymization path.

## 8. What A Third-Party Observer Can And Cannot Learn

Purpose: summarize the practical privacy result from the outside.

```mermaid
flowchart TD
    classDef seen fill:#334155,stroke:#64748b,color:#fff
    classDef hidden fill:#0d9488,stroke:#134e4a,color:#fff

    A["Observer sees relay funding,<br/>batch commits, loan accounts,<br/>and public/bucketed borrow amounts"]:::seen
    B["Observer cannot map<br/>depositor wallet to commitment"]:::hidden
    C["Observer cannot identify<br/>which note was withdrawn"]:::hidden
    D["Observer cannot link<br/>borrower wallet to collateral note"]:::hidden
    E["Observer cannot link<br/>loan proceeds to a known wallet"]:::hidden
    F["Observer cannot see a normal<br/>repayment transfer graph in Full Privacy mode"]:::hidden
    G["Observer can still see<br/>loan count and some amount metadata"]:::seen

    A --> B
    A --> C
    A --> D
    D --> E
    D --> F
    A --> G
```

Final interpretation: ShieldLend does not make all protocol state invisible. It keeps enough state public for lending safety while breaking the links that create wallet-level credit surveillance.
