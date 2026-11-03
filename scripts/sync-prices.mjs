import { resolve } from 'node:path';
import { PricingService } from '../src/pricing-service.js';
const dataDir = resolve(process.argv[2] ?? '.cache/prices');
const service = new PricingService({ dataDir });
await service.initialize();
await service.refresh(true);
console.log(JSON.stringify({ dataDir, ...service.getStatus() }, null, 2));
await service.dispose();
