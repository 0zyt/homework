import initSqlJs from "sql.js";
import fs from "node:fs";

const dbPath = process.argv[2];
const buf = fs.readFileSync(dbPath);
const SQL = await initSqlJs();
const db = new SQL.Database(buf);

console.log("Tables:", db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")[0].values.map(r => r[0]));
console.log("Alerts:", db.exec("SELECT count(*) FROM alerts")[0].values[0][0]);
console.log("Candidates:", db.exec("SELECT count(*) FROM pattern_candidates")[0].values[0][0]);
console.log("Patterns:", db.exec("SELECT count(*) FROM business_patterns")[0].values[0][0]);
console.log("Replays:", db.exec("SELECT count(*) FROM replay_results")[0].values[0][0]);
console.log("Analyses:", db.exec("SELECT count(*) FROM candidate_analyses")[0].values[0][0]);
console.log("Runs:", db.exec("SELECT count(*) FROM discovery_runs")[0].values[0][0]);
console.log("\nSample alerts:");
const alerts = db.exec("SELECT id, url, http_method, risk_level FROM alerts LIMIT 3");
console.log(JSON.stringify(alerts[0].values, null, 2));
console.log("\nSample candidates:");
const cands = db.exec("SELECT id, candidate_type, status, alert_count FROM pattern_candidates LIMIT 3");
console.log(JSON.stringify(cands[0].values, null, 2));
