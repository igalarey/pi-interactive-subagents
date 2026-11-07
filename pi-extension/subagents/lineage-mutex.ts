import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

const PROTOCOL = '{"version":2,"kind":"sqlite-mutex"}';
const WAIT_MS = 1_000;

function regularFile(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Lineage mutex requires a single-link regular file: ${path}`);
  return stat;
}

/** The fence is permanent: older mkdir-lock runtimes must never enter this ledger. */
export async function acquireLineageMutex(file: string, initialize: boolean): Promise<() => void> {
  const deadline = Date.now() + WAIT_MS;
  let SQLite: typeof import("node:sqlite");
  try { SQLite = await import("node:sqlite"); }
  catch { throw new Error("Node SQLite (node:sqlite) is required for the lineage mutex; no unsafe fallback is available"); }
  const fence = `${file}.lock`;
  const marker = `${fence}/protocol.json`;
  const database = `${fence}/mutex.sqlite`;
  if (initialize && process.env.PI_SUBAGENT_LINEAGE_FILE) {
    throw new Error("Inherited descendants cannot initialize or migrate a root lineage mutex");
  }
  let created = false;
  try { lstatSync(fence); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!initialize) throw new Error("Root initialization of the lineage mutex is required before inherited operations");
    mkdirSync(dirname(file), { recursive: true });
    try { mkdirSync(fence, { mode: 0o700 }); created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const directory = lstatSync(fence);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error(`Invalid lineage mutex fence: ${fence}`);
  if (created) {
    // A crash during initialization leaves an incomplete fence, never permission to reclaim it.
    closeSync(openSync(database, "wx", 0o600));
    const db = new SQLite.DatabaseSync(database);
    try { db.exec("CREATE TABLE mutex_protocol(version INTEGER NOT NULL); INSERT INTO mutex_protocol VALUES (2)"); }
    finally { db.close(); }
    writeFileSync(`${marker}.tmp`, PROTOCOL, { flag: "wx", mode: 0o600 });
    renameSync(`${marker}.tmp`, marker);
  }
  const timeout = () => new Error(
    `Timed out acquiring subagent lineage lock: ${file}. Live SQLite ownership or an incomplete/legacy fence prevents entry. ` +
    "Automatic stale-lock deletion is disabled; never delete or replace this protocol fence or mutex database.",
  );
  for (;;) {
    try {
      const stat = regularFile(marker);
      if (stat.size > 256 || readFileSync(marker, "utf8") !== PROTOCOL) throw new Error(`Unknown lineage mutex protocol: ${marker}`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (Date.now() >= deadline) throw timeout();
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  }
  const identity = regularFile(database);
  let db: DatabaseSync | undefined;
  const checkIdentity = () => {
    const current = regularFile(database), dir = lstatSync(fence);
    if (current.dev !== identity.dev || current.ino !== identity.ino || dir.dev !== directory.dev || dir.ino !== directory.ino || !dir.isDirectory() || dir.isSymbolicLink()) {
      throw new Error("Lineage mutex path identity changed; refusing a replacement lock");
    }
  };
  try {
    db = new SQLite.DatabaseSync(database);
    checkIdentity();
    db.exec("PRAGMA busy_timeout=0");
    const version = db.prepare("SELECT version FROM mutex_protocol").all();
    if (version.length !== 1 || version[0]?.version !== 2) throw new Error("Invalid lineage mutex database protocol");
    for (;;) {
      checkIdentity();
      try { db.exec("BEGIN IMMEDIATE"); break; }
      catch (error) {
        // SQLITE_BUSY is contention, not permission to repair, replace or remove a lock.
        if ((error as { errcode?: number }).errcode !== 5) throw error;
        if (Date.now() >= deadline) throw timeout();
        await new Promise(resolve => setTimeout(resolve, 15));
      }
    }
    checkIdentity();
    const connection = db;
    db = undefined;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try { connection.exec("ROLLBACK"); }
      finally { connection.close(); }
    };
  } catch (error) {
    db?.close();
    throw error;
  }
}
