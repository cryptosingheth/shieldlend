# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

ShieldLend is a ZK-based private DeFi lending protocol that handles sensitive cryptographic operations and user funds. Security is our highest priority.

### How to Report

**Please DO NOT open public issues for security vulnerabilities.**

Instead, report security issues privately via:

- **Email**: security@shieldlend.xyz (preferred)
- **GitHub Security Advisories**: [Create a private advisory](https://github.com/cryptosingheth/shieldlend/security/advisories/new)

### What to Include

When reporting a vulnerability, please provide:

1. **Description**: Clear explanation of the vulnerability
2. **Impact**: What could an attacker accomplish?
3. **Steps to Reproduce**: Detailed instructions to demonstrate the issue
4. **Affected Components**: Specific contracts, circuits, or files
5. **Proof of Concept**: Code, test cases, or screenshots if applicable
6. **Suggested Fix**: If you have recommendations

### Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial Assessment**: Within 7 days
- **Resolution Timeline**: Depends on severity
  - Critical: 7-14 days
  - High: 14-30 days
  - Medium/Low: 30-60 days

### Bug Bounty

We are establishing a bug bounty program. Details will be announced soon. Critical vulnerabilities in the following areas are of particular interest:

- **Circuit Logic**: Soundness or completeness bugs in Circom circuits
- **Smart Contracts**: Reentrancy, access control, or fund drainage issues
- **Cryptographic Implementation**: Pedersen hash, Merkle tree, or proof verification flaws
- **Front-running/MEV**: Attacks on deposit/withdraw privacy
- **ZK Verification**: Bypassing zkVerify attestation

### Scope

**In Scope:**
- Solidity contracts in `/contracts`
- Circom circuits in `/circuits`
- Frontend proof generation in `/frontend/src/circuits`
- zkVerify integration contracts

**Out of Scope:**
- Third-party dependencies (OpenZeppelin, Circomlib)
- Issues in test code or documentation
- Social engineering attacks
- Already disclosed vulnerabilities

### Safe Harbor

We follow responsible disclosure principles:
- Researchers will not be prosecuted for good-faith security research
- We will not take legal action against researchers who follow this policy
- We will publicly acknowledge your contribution (with your permission)

## Security Considerations

### For Users

1. **Note Security**: Your deposit note (secret + nullifier) is your only access key. Never share it and store it securely offline.
2. **Amount Privacy**: While ShieldLend hides the link between deposits and withdrawals, deposit amounts are visible on-chain during the initial transaction.
3. **Timing Correlation**: Consider waiting between deposit and withdrawal to reduce timing-based deanonymization risks.
4. **Gas Costs**: ZK proof generation and verification incur higher gas costs than standard DeFi transactions.

### For Developers

1. **Circuit Constraints**: Always verify constraint counts when modifying circuits
2. **Trusted Setup**: The current implementation uses a development trusted setup. Production deployments require a secure multi-party computation ceremony.
3. **Merkle Tree Depth**: Current depth supports 2^20 leaves. Monitor usage and plan for tree rotation if approaching capacity.
4. **Nullifier Registry**: Ensure nullifier uniqueness is strictly enforced to prevent double-spending.

## Audit Status

| Component | Status | Auditor | Date |
|-----------|--------|---------|------|
| Circuits | :yellow_circle: Pending | TBD | - |
| Contracts | :yellow_circle: Pending | TBD | - |
| Frontend | :yellow_circle: Pending | TBD | - |

*Last Updated: March 2026*

## Contact

- Security Team: security@shieldlend.xyz
- Project Lead: [@cryptosingheth](https://github.com/cryptosingheth)
- Emergency Contact: See repository maintainers

---

Thank you for helping keep ShieldLend and its users safe!
