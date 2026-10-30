// The server's entry: put the store's database snapshot in place when it is newer than the local file (a fresh
// revision has none), then start the server. db.mjs opens the file at import time, so the restore must run first;
// index.mjs imports this module's state back (restoredFrom) for /api/health and the reports.
import { media } from "./media.mjs";
import { restoreIfNewer, DB_PATH } from "./snapshot.mjs";

await restoreIfNewer({ path: DB_PATH, media });
await import("./index.mjs");
