declare module 'circomlibjs' {
  interface PoseidonFunction {
    (inputs: (bigint | number)[]): Uint8Array;
    F: {
      toObject(x: Uint8Array): bigint;
    };
  }
  export function buildPoseidon(): Promise<PoseidonFunction>;
}

declare module 'snarkjs' {
  interface Proof {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: string;
    curve: string;
  }
  interface FullProveResult {
    proof: Proof;
    publicSignals: string[];
  }
  export const groth16: {
    fullProve(
      input: Record<string, unknown>,
      wasmFile: string | { type: string; data: Uint8Array },
      zkeyFileName: string | { type: string; data: Uint8Array },
    ): Promise<FullProveResult>;
    verify(
      vk: unknown,
      publicSignals: string[],
      proof: Proof,
    ): Promise<boolean>;
  };
}
