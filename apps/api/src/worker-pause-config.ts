/**
 * Deployment-scoped Worker pause (ADR-0022).
 *
 * The half of pause that has no route and no permission, because it has no
 * principal. `authorization.md`:
 *
 *     The MVP does not model a cross-Organization Human PlatformOperator
 *     principal. Deployment or database operators may pause Workers, preserve
 *     evidence, and restore infrastructure under the Operations controls, but
 *     they cannot use that access to authorize Organization-scoped replay or
 *     skip.
 *
 * So a global pause is exercised the way deployment operators exercise
 * everything else — by changing the deployment. It is what an operator reaches
 * for when the Worker itself is defective rather than one tenant's work, and it
 * is the state Worker readiness must verify: "the Worker type is not
 * administratively paused".
 *
 *     WORKER_PAUSED_TYPES=OutboxPublication,MemoryGeneration
 *
 * Read once at startup rather than per drain. A pause that could change under a
 * running loop would make the readiness answer and the claim behaviour disagree
 * for as long as the process lived, and a deployment control that takes effect
 * on restart is what every other deployment control here does.
 */

import {
  PAUSABLE_WORKER_TYPES,
  isPausableWorkerType,
  type PausableWorkerType,
} from "@aios/application";

export interface DeploymentPause {
  readonly paused: ReadonlySet<PausableWorkerType>;
  /** Names in the variable that pause nothing, so startup can say so. */
  readonly unrecognised: readonly string[];
  /** For the startup log line, in the shape the other `choose*` helpers use. */
  readonly reason: string;
}

export const readDeploymentPause = (
  env: NodeJS.ProcessEnv = process.env,
): DeploymentPause => {
  const raw = env["WORKER_PAUSED_TYPES"] ?? "";
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  const paused = new Set<PausableWorkerType>();
  const unrecognised: string[] = [];

  for (const name of names) {
    // Reported rather than ignored, and rather than fatal. A typo that silently
    // paused nothing would leave an operator believing they had contained an
    // incident; refusing to start would turn a typo in an operational control
    // into an outage.
    if (isPausableWorkerType(name)) paused.add(name);
    else unrecognised.push(name);
  }

  const reason =
    paused.size === 0
      ? names.length === 0
        ? "no deployment pause"
        : `WORKER_PAUSED_TYPES named nothing pausable (${PAUSABLE_WORKER_TYPES.join(", ")})`
      : `paused by deployment: ${[...paused].join(", ")}`;

  return { paused, unrecognised, reason };
};
