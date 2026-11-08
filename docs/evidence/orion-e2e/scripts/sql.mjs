import { createRequire } from "node:module";
const require = createRequire("/project/.work/engine-1023/tree/node_modules/@paperclipai/db/package.json");
const pg = require("postgres");
const sql = pg("postgres://paperclip:paperclip@127.0.0.1:54330/paperclip");
const r = await sql.unsafe(process.argv[2]); console.log(JSON.stringify(r).slice(0, 800)); await sql.end();
