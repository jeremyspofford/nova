import { Db } from '../../src/core/db.ts';

const db = new Db(':memory:');
try {
  const migration = db.migrate();
  const schema = db.all("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name");
  const names = new Set(schema.map(row => row.name));
  console.log(JSON.stringify({
    baseline: 'd948aa0a442a9f930b86f4516eeea21981b76714',
    database: ':memory:',
    migration,
    graph_nodes: names.has('graph_nodes'),
    graph_edges: names.has('graph_edges'),
    schema,
  }, null, 2));
} finally { db.close(); }
