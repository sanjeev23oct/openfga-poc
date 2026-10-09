// Creates a fresh OpenFGA store, writes the model from fga/model.fga and loads the seed tuples.
// The store and model ids are saved to app/.fga-store.json for the server to pick up.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OpenFgaClient } from '@openfga/sdk';
import { transformer } from '@openfga/syntax-transformer';
import { API_URL, STORE_FILE } from '../src/fga.js';
import { tuplesFromSeed } from '../src/org.js';

const modelPath = fileURLToPath(new URL('../../fga/model.fga', import.meta.url));
const model = transformer.transformDSLToJSONObject(readFileSync(modelPath, 'utf8'));

const { id: storeId } = await new OpenFgaClient({ apiUrl: API_URL }).createStore({
  name: 'zone-access-poc',
});
const fga = new OpenFgaClient({ apiUrl: API_URL, storeId });

const { authorization_model_id: modelId } = await fga.writeAuthorizationModel(model);

const tuples = tuplesFromSeed();
// The server accepts at most 100 tuples per write.
for (let i = 0; i < tuples.length; i += 100) {
  await fga.write({ writes: tuples.slice(i, i + 100) }, { authorizationModelId: modelId });
}

writeFileSync(STORE_FILE, JSON.stringify({ storeId, modelId }, null, 2) + '\n');
console.log(`Store ${storeId}\nModel ${modelId}\nWrote ${tuples.length} tuples`);
