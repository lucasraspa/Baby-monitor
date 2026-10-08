import { createMonitorServer } from './server.js';

const PORT = Number(process.env.PORT ?? 8830);

createMonitorServer().listen(PORT, '0.0.0.0', () => {
  process.stdout.write(`baby-monitor escuchando en :${PORT}\n`);
});

process.on('SIGTERM', () => process.exit(0));
