// Writes the seed tuples to fga/tuples.json so the fga CLI tests use the same data as the app.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tuplesFromSeed } from '../src/org.js';

const out = fileURLToPath(new URL('../../fga/tuples.json', import.meta.url));
const tuples = tuplesFromSeed();
writeFileSync(out, JSON.stringify(tuples, null, 2) + '\n');
console.log(`Wrote ${tuples.length} tuples to ${out}`);
