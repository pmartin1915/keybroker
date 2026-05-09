// Standalone worker used by tests/concurrent.test.ts.
// Spawned via tsx, given a db path and token id; consumes the token once
// and prints "ok" if it won the race, the error code otherwise.
import { SqliteStore } from "../../src/store-sqlite.js";

const dbPath = process.argv[2];
const tokenId = process.argv[3];
if (!dbPath || !tokenId) {
  console.error("usage: consume-worker.ts <dbPath> <tokenId>");
  process.exit(2);
}

const store = new SqliteStore(dbPath);
try {
  const result = store.consumeToken(tokenId);
  console.log(typeof result === "string" ? result : "ok");
} finally {
  store.close();
}
