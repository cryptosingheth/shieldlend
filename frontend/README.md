# frontend/

Next.js frontend for ShieldLend. Wallet connection via wagmi. Browser-side ZK proof generation via snarkjs WASM.

## Status

🔜 Coming in Step 7.

## Planned Pages

| Route | Description |
|-------|-------------|
| `/` | Landing page — project overview |
| `/deposit` | Private deposit flow: enter amount → generate commitment → submit tx → download note |
| `/withdraw` | Private withdrawal flow: upload note → generate proof → submit to zkVerify → withdraw |
| `/borrow` | Collateral proof + borrow flow |

## Key Design Constraint

All proof generation happens in the browser using snarkjs WASM. The user's `secret` and `nullifier` never leave their device. There is no backend server that handles private user data.

## Stack

- Next.js (App Router)
- wagmi + viem (wallet connection, contract reads/writes)
- snarkjs (browser-side Groth16 proof generation)
- zkVerifyJS SDK (proof submission)
