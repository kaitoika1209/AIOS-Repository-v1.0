import { parseEnvironment } from '@aios/config';
import { baselineProfile, validateProfile } from './runtime-profile.js';

const allowedRoles = new Set(['outbox-publisher', 'local-consumer', 'memory-generation', 'lease-recovery', 'replay']);
const environment = parseEnvironment(process.env);
const roles = environment.AIOS_WORKER_ROLES.split(',').map((role) => role.trim());
const profile = validateProfile(baselineProfile);

for (const role of roles) {
  if (!allowedRoles.has(role)) throw new Error(`Unknown worker role: ${role}`);
}

console.info(JSON.stringify({ event: 'worker.started', roles, environment: environment.NODE_ENV, profileVersion: profile.version }));
