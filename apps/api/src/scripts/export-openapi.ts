/** Writes the OpenAPI document to stdout or the given file: `npm run openapi -- docs/openapi.json` */
import fs from 'node:fs/promises';
import { buildOpenApiDocument } from '../http/openapi.js';

const doc = JSON.stringify(buildOpenApiDocument(), null, 2);
const target = process.argv[2];
if (target) {
  await fs.writeFile(target, doc);
  console.log(`OpenAPI document written to ${target}`);
} else {
  process.stdout.write(doc);
}
