import { parseEnvironment } from '@aios/config';

const allowedRoles = new Set(['outbox-publisher', 'local-consumer', 'memory-generation', 'lease-recovery', 'replay']);
const environment = parseEnvironment(process.env);
const roles = environment.AIOS_WORKER_ROLES.split(',').map((role) => role.trim());

for (const role of roles) {
  if (!allowedRoles.has(role)) throw new Error(`Unknown worker role: ${role}`);
}

// M0 validates composition and configuration only. Durable loops arrive with their owning milestone.
console.info(JSON.stringify({ event: 'worker.started', roles, environment: environment.NODE_ENV }));
