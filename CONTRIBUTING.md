# Contributing to ShieldLend

This guide covers the team workflow for contributing to ShieldLend.

---

## Branch Naming

| Type | Pattern | Example |
|------|---------|---------|
| Feature | `feat/<short-description>` | `feat/deposit-circuit` |
| Bug fix | `fix/<short-description>` | `fix/nullifier-collision` |
| Documentation | `docs/<short-description>` | `docs/circuit-constraints` |
| Refactor | `refactor/<short-description>` | `refactor/merkle-tree` |
| Tests | `test/<short-description>` | `test/withdraw-double-spend` |

---

## Commit Message Format

```
<type>: <short summary>

<optional longer description>

Co-Authored-By: <name> <email>
```

Types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`

---

## Pull Request Process

1. Create a branch from `main`
2. Make your changes
3. Run tests: `forge test` (contracts), `snarkjs` verification (circuits)
4. Open a PR with a clear description of what changed and why
5. Request review from at least one other team member
6. Merge only after approval

---

## Repository Structure

```
shieldlend/
├── circuits/           # Circom ZK circuits
│   ├── deposit.circom
│   ├── withdraw.circom
│   └── collateral.circom
├── contracts/          # Solidity smart contracts
│   └── src/
│       ├── ShieldedPool.sol
│       ├── NullifierRegistry.sol
│       └── LendingPool.sol
├── frontend/           # Next.js frontend
├── scripts/            # Deployment + trusted setup scripts
├── docs/               # Architecture, circuit, and tech-stack documentation
├── README.md
├── ROADMAP.md
└── CONTRIBUTING.md
```

---

## Development Environment

Prerequisites:
- Node.js 20+
- Rust (for Circom compiler)
- Foundry (`curl -L https://foundry.paradigm.xyz | bash`)
- Circom (`cargo install --git https://github.com/iden3/circom`)
- snarkjs (`npm install -g snarkjs`)

Setup instructions will be added to `README.md` once Step 1 (scaffold) is complete.

---

## Security Notes

- **Never commit `.env` files** — they contain private keys
- **Never commit `.zkey` files** — they are large binary proving keys
- **Never commit `keys/` directory** — same reason
- Use `.env.example` to document required environment variables without values
- Report security issues privately to the team before opening a public issue
