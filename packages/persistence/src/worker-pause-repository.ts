/**
 * Administrative Worker pauses (ADR-0022).
 *
 * The store behind the Organization-scoped pause commands, and the table the
 * Outbox claim consults. Small, hot, and read on every drain — which is why the
 * lookup is a primary-key probe on `(organization_id, worker_type)` rather than
 * a scan.
 */

import type { PoolClient } from "pg";

import { OrganizationId } from "@aios/types";
import type {
  PausableWorkerType,
  WorkerPause,
  WorkerPauseRepository,
} from "@aios/application";

interface PauseRow {
  organization_id: string;
  worker_type: string;
  paused_at: Date;
  paused_by_identity_id: string;
  paused_by_membership_id: string;
  reason_code: string;
  reason: string;
}

const toPause = (row: PauseRow): WorkerPause => ({
  organizationId: OrganizationId(row.organization_id),
  // Narrowed by `ck_worker_pause_type`, so the database cannot hold a value
  // outside the union that the application declares.
  workerType: row.worker_type as PausableWorkerType,
  pausedAt: row.paused_at,
  pausedByIdentityId: row.paused_by_identity_id,
  pausedByMembershipId: row.paused_by_membership_id,
  reasonCode: row.reason_code,
  reason: row.reason,
});

export class PostgresWorkerPauseRepository implements WorkerPauseRepository {
  constructor(private readonly client: PoolClient) {}

  /**
   * Insert, or leave the existing pause alone.
   *
   * `ON CONFLICT DO NOTHING` with a second read rather than `DO UPDATE`: the
   * first pause carries the reason that explains the current state, and an
   * operator repeating the command should not silently overwrite it. The
   * returning-then-selecting shape is what makes the caller see the pause that
   * is actually in force rather than the one it tried to write.
   */
  async pause(pause: WorkerPause): Promise<WorkerPause> {
    const inserted = await this.client.query<PauseRow>(
      `INSERT INTO worker_pauses (
         organization_id, worker_type, paused_at,
         paused_by_identity_id, paused_by_membership_id, reason_code, reason
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (organization_id, worker_type) DO NOTHING
       RETURNING *`,
      [
        pause.organizationId,
        pause.workerType,
        pause.pausedAt,
        pause.pausedByIdentityId,
        pause.pausedByMembershipId,
        pause.reasonCode,
        pause.reason,
      ],
    );

    const row = inserted.rows[0];
    if (row !== undefined) return toPause(row);

    const existing = await this.client.query<PauseRow>(
      `SELECT * FROM worker_pauses WHERE organization_id = $1 AND worker_type = $2`,
      [pause.organizationId, pause.workerType],
    );
    // The conflict target is the primary key, so a row exists by construction —
    // and it is in this transaction, so nothing can have removed it in between.
    return toPause(existing.rows[0]!);
  }

  async resume(
    organizationId: OrganizationId,
    workerType: PausableWorkerType,
  ): Promise<boolean> {
    const result = await this.client.query(
      `DELETE FROM worker_pauses WHERE organization_id = $1 AND worker_type = $2`,
      [organizationId, workerType],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listFor(organizationId: OrganizationId): Promise<readonly WorkerPause[]> {
    const result = await this.client.query<PauseRow>(
      `SELECT * FROM worker_pauses WHERE organization_id = $1 ORDER BY worker_type`,
      [organizationId],
    );
    return result.rows.map(toPause);
  }
}
