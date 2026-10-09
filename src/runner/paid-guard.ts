export class PaidDeniedError extends Error {
  readonly code = "paid_denied";
  constructor(message: string) {
    super(message);
  }
}

export interface PaidLaneProfile {
  lane: string;
  allowPaid: string | undefined;
  configHash: string;
  expectedHash: string;
  numRetries: number[];
  deploymentCount: number;
  fallbackCount: number;
  containsOpenAiHost: boolean;
  deploymentMaxRetries: number[];
}

const LANE_P_NOT_IN_SLICE = "Lane P execution is not part of this slice";

export function assertPaidLane(profile: PaidLaneProfile): void {
  if (profile.lane !== "P") return;
  if (profile.allowPaid !== "1") {
    throw new PaidDeniedError("ROUTEFORGE_ALLOW_PAID is not 1");
  }
  if (profile.configHash !== profile.expectedHash) {
    throw new PaidDeniedError("Lane P config hash does not match the manifest");
  }
  const retriesOk = profile.numRetries.length > 0 && profile.numRetries.every((value) => value === 0);
  const sdkRetriesOk =
    profile.deploymentMaxRetries.length === profile.deploymentCount &&
    profile.deploymentMaxRetries.every((value) => value === 0);
  if (!retriesOk || !sdkRetriesOk || profile.deploymentCount !== 1 || profile.fallbackCount !== 0) {
    throw new PaidDeniedError("Lane P config is not the locked single-deployment profile");
  }
  if (!profile.containsOpenAiHost) {
    throw new PaidDeniedError("Lane P config is not the OpenAI deployment file");
  }
  throw new PaidDeniedError(LANE_P_NOT_IN_SLICE);
}

export function paidDenialStopsBeforeSocket(error: unknown): boolean {
  return error instanceof PaidDeniedError;
}
