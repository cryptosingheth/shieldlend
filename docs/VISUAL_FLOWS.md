# ShieldLend Solana — Visual Architecture Flows

These diagrams are written for mentors, judges, investors, and implementation contributors. They show what each privacy layer does and where lending safety checks happen.

---

## 1. Protocol Role Map

```mermaid
flowchart LR
    classDef privacy fill:#0d9488,stroke:#134e4a,color:#fff
    classDef program fill:#1e293b,stroke:#475569,color:#e2e8f0
    classDef external fill:#312e81,stroke:#6366f1,color:#fff

    User["User Browser\nnotes, proofs, history"]:::program
    IKA["IKA dWallet\nrelay + authorization"]:::external
    PER["MagicBlock PER\nprivate execution batches"]:::privacy
    Pay["MagicBlock Private Payments\nprivate repay settlement"]:::privacy
    Umbra["Umbra\nstealth output addresses"]:::privacy
    Encrypt["Encrypt FHE\nencrypted oracle and health"]:::external
    SP["shielded_pool\nSOL custody + Merkle tree"]:::program
    LP["lending_pool\nloan accounting + checks"]:::program
    NR["nullifier_registry\nActive / Locked / Spent"]:::program

    User --> IKA
    IKA --> PER
    PER --> SP
    SP <--> LP
    LP <--> NR
    LP --> Pay
    LP --> Encrypt
    SP --> Umbra
```

---

## 2. Deposit Privacy Flow

```mermaid
flowchart TD
    classDef privacy fill:#0d9488,stroke:#134e4a,color:#fff
    classDef public fill:#334155,stroke:#64748b,color:#fff

    A["User creates note\nsecret + nullifier + denomination"]:::privacy
    B["Commitment\nPoseidon(secret, nullifier, denomination)"]:::privacy
    C["User funds IKA relay\npublic funding tx"]:::public
    D["MagicBlock PER batches deposits\ninside TDX enclave"]:::privacy
    E["VRF + private entropy add dummies"]:::privacy
    F["Single batch insert to Merkle tree"]:::public
    G["Encrypted local note saved"]:::privacy

    A --> B --> C --> D --> E --> F --> G
```

What this proves visually: the public funding transaction is not one-to-one with a final commitment.

---

## 3. Withdrawal Privacy Flow

```mermaid
flowchart TD
    classDef privacy fill:#0d9488,stroke:#134e4a,color:#fff
    classDef safety fill:#b45309,stroke:#92400e,color:#fff
    classDef public fill:#334155,stroke:#64748b,color:#fff

    A["User loads encrypted note"]:::privacy
    B["Build ring proof\nK=16 plus dummies"]:::privacy
    C["IKA relay submits withdrawal"]:::privacy
    D["groth16-solana verifies proof"]:::safety
    E["Nullifier: Active to Spent"]:::safety
    F["PER exit batch\nmixed with borrow disbursements"]:::privacy
    G["Umbra stealth address receives funds"]:::privacy
    H["User controls stealth wallet directly"]:::privacy

    A --> B --> C --> D --> E --> F --> G --> H
```

Key point: the ring proof hides which commitment was spent, the relay hides who submitted the proof, and Umbra hides where funds went.

---

## 4. Borrow Privacy and Lending Safety Flow

```mermaid
flowchart TD
    classDef privacy fill:#0d9488,stroke:#134e4a,color:#fff
    classDef safety fill:#b45309,stroke:#92400e,color:#fff
    classDef public fill:#334155,stroke:#64748b,color:#fff

    A["User selects collateral note"]:::privacy
    B["Collateral ring proof\nhides which note"]:::privacy
    C["Borrow amount or bucket\npublic accounting input"]:::public
    D["LTV verified by circuit and program"]:::safety
    E["Nullifier: Active to Locked"]:::safety
    F["IKA dWallet co-signs disbursement"]:::safety
    G["PER exit batch\nmixed with withdrawals"]:::privacy
    H["Umbra stealth address receives loan"]:::privacy
    I["LoanAccount PDA created\npublic loan exists, identity hidden"]:::public

    A --> B --> C --> D --> E --> F --> G --> H
    E --> I
```

Key point: public borrow amount supports solvency and liquidation, but does not reveal the borrower wallet or original depositor.

---

## 5. Private Repayment Flow

```mermaid
flowchart TD
    classDef privacy fill:#0d9488,stroke:#134e4a,color:#fff
    classDef safety fill:#b45309,stroke:#92400e,color:#fff
    classDef public fill:#334155,stroke:#64748b,color:#fff

    A["User loads loan and collateral note"]:::privacy
    B["Program computes outstanding balance\nfrom public rate history"]:::public
    C["MagicBlock Private Payment settles repayment"]:::privacy
    D["Receipt binds loanId, nullifierHash,\noutstanding, vault, epoch"]:::safety
    E["repay_ring proof binds collateral nullifier to receipt"]:::privacy
    F["IKA relay submits repay instruction"]:::privacy
    G["LendingPool verifies proof + receipt"]:::safety
    H["Nullifier: Locked to Active"]:::safety
    I["Collateral can withdraw through normal privacy flow"]:::privacy

    A --> B --> C --> D --> E --> F --> G --> H --> I
```

If private payments are unavailable, repayment can still hide identity through relay submission, but amount privacy is not claimed.

---

## 6. Liquidation and Bad-Debt Control

```mermaid
flowchart TD
    classDef privacy fill:#0d9488,stroke:#134e4a,color:#fff
    classDef safety fill:#b45309,stroke:#92400e,color:#fff
    classDef public fill:#334155,stroke:#64748b,color:#fff

    A["Encrypted oracle price update"]:::privacy
    B["Encrypt computes health factor"]:::privacy
    C["Breach count increments only on consecutive breaches"]:::safety
    D["Request liquidation reveal"]:::public
    E["Encrypt threshold decrypts bound handle"]:::safety
    F{"Confirmed liquidatable?"}:::safety
    G["IKA FutureSign executes pre-consented liquidation"]:::safety
    H["Full liquidation MVP\nreserve + liquidator accounting"]:::safety
    I["Nullifier: Locked to Spent"]:::safety

    A --> B --> C --> D --> E --> F
    F -->|"yes"| G --> H --> I
    F -->|"no"| J["Clear pending flags"]
```

The MVP avoids partial liquidation to reduce bad-debt and accounting risk.

---

## 7. User History and Scoped Disclosure

```mermaid
flowchart LR
    classDef privacy fill:#0d9488,stroke:#134e4a,color:#fff
    classDef public fill:#334155,stroke:#64748b,color:#fff

    Ops["Deposit / Withdraw / Borrow / Repay"]:::public
    Journal["Encrypted local history journal"]:::privacy
    Select["User selects records to disclose"]:::privacy
    Packet["Disclosure packet\nproof signals + tx signatures + receipt hashes"]:::privacy
    Auditor["Auditor verifies selected facts"]:::public

    Ops --> Journal --> Select --> Packet --> Auditor
```

There is no protocol-wide viewing key. Disclosure is user-controlled and scoped.

---

## 8. Observer View

```mermaid
flowchart TD
    classDef seen fill:#334155,stroke:#64748b,color:#fff
    classDef hidden fill:#0d9488,stroke:#134e4a,color:#fff

    A["Observer sees relay funding and batch txs"]:::seen
    B["Observer sees LoanAccount count"]:::seen
    C["Observer sees public or bucketed borrow amount"]:::seen
    D["Observer does not see depositor to commitment mapping"]:::hidden
    E["Observer does not see collateral note identity"]:::hidden
    F["Observer does not see borrower wallet"]:::hidden
    G["Observer does not see output wallet identity"]:::hidden
    H["Observer does not see repayment transfer graph in Full Privacy mode"]:::hidden

    A --> D
    B --> E
    C --> F
    F --> G
    G --> H
```
