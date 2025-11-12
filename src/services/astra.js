const {
  ASTRA_DB_ID,
  ASTRA_DB_REGION,
  ASTRA_DB_APPLICATION_TOKEN,
  ASTRA_DB_NAMESPACE = 'default_keyspace',
} = process.env;

const basePath = `https://${ASTRA_DB_ID}-${ASTRA_DB_REGION}.apps.astra.datastax.com/api/rest/v2/namespaces/${ASTRA_DB_NAMESPACE}/collections`;
const headers = {
  'X-Cassandra-Token': ASTRA_DB_APPLICATION_TOKEN,
  'Content-Type': 'application/json',
};

let setupError, setupPromise;
const cache = new Map();

const ensureClientReady = async () => {
  if (setupError) throw setupError;
  if (setupPromise) return setupPromise;

  setupPromise = (async () => {
    if (!ASTRA_DB_ID || !ASTRA_DB_REGION || !ASTRA_DB_APPLICATION_TOKEN) {
      setupError = new Error('Missing Astra DB credentials.');
      return;
    }

    try {
      const res = await fetch(basePath, { method: 'GET', headers });
      if (!res.ok) throw new Error(`Status ${res.status}`);
    } catch (err) {
      setupError = new Error(`Setup failed: ${err.message}`);
    }
  })();

  await setupPromise;
  if (setupError) throw setupError;
};

export const getCollection = async (name) => {
  if (!name) throw new Error('Collection name required.');
  await ensureClientReady();
  if (cache.has(name)) return cache.get(name);

  const url = `${basePath}/${name}`;
  const ops = {
    get: (id) => fetch(`${url}/${id}`, { method: 'GET', headers }).then(r => r.json()),
    post: (data) => fetch(url, { method: 'POST', headers, body: JSON.stringify(data) }).then(r => r.json()),
    put: (id, data) => fetch(`${url}/${id}`, { method: 'PUT', headers, body: JSON.stringify(data) }).then(r => r.json()),
    patch: (id, data) => fetch(`${url}/${id}`, { method: 'PATCH', headers, body: JSON.stringify(data) }).then(r => r.json()),
    delete: (id) => fetch(`${url}/${id}`, { method: 'DELETE', headers }).then(r => r.json()),
    find: (query) => {
      const u = new URL(url);
      u.searchParams.append('where', JSON.stringify(query));
      return fetch(u.toString(), { method: 'GET', headers }).then(r => r.json());
    },
  };

  cache.set(name, ops);
  return ops;
};
