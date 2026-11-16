// Applies pending SQL migrations and exits (the server also does this at startup).
import { migrate, pool } from "./db.js";

try {
  await migrate();
  console.log("Migrations up to date.");
} catch (e) {
  console.error("Migration failed:", e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
