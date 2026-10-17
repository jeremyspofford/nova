// A test database with every migration (0019_requests included).
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';

export async function openRequestsDb(): Promise<NovaDatabase> {
  const db = openDatabase({ path: ':memory:' });
  await migrate(db);
  return db;
}
