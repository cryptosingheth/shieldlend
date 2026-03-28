# scripts/

Deployment and trusted setup scripts.

## Planned Scripts

| File | Description |
|------|-------------|
| `setup.sh` | Full trusted setup: compile circuits → Powers of Tau → zkey → vkey → Solidity verifier |
| `deploy.s.sol` | Foundry deploy script: ShieldedPool + NullifierRegistry + LendingPool |
| `relayer.ts` | Watches zkVerify attestation events → calls ShieldedPool.withdraw on-chain |

## Status

🔜 Coming in Steps 4–6.
