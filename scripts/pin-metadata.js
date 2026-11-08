// Épingle (pin) les métadonnées de démo sur IPFS via Pinata et enregistre les VRAIS CID.
//   1) .env : PINATA_JWT=eyJ...   (Pinata -> API Keys -> New Key -> JWT)
//   2) npm run pin               -> écrit frontend/metadata/cids.json  { "solar-school.json": "Qm..." }
//   3) npm run backend:seed      -> seed.js utilise alors "ipfs://<CID>" au lieu de "file:<nom>"
// Droit de clé nécessaire : pinJSONToIPFS OU pinFileToIPFS (le script essaie l'un puis l'autre).
require("dotenv").config();
const fs = require("fs"), path = require("path");

const BASE = process.env.PINATA_API_URL || "https://api.pinata.cloud/pinning";

async function pinJson(jwt, name, obj) {
  return fetch(`${BASE}/pinJSONToIPFS`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ pinataContent: obj, pinataMetadata: { name } }),
  });
}
async function pinFile(jwt, name, text) {
  const form = new FormData();
  form.append("file", new Blob([text], { type: "application/json" }), name);
  form.append("pinataMetadata", JSON.stringify({ name }));
  return fetch(`${BASE}/pinFileToIPFS`, { method: "POST", headers: { Authorization: `Bearer ${jwt}` }, body: form });
}

async function main() {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) throw new Error("PINATA_JWT manquant dans .env");
  const dir = path.join(__dirname, "..", "frontend", "metadata");
  const out = {};
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json") && x !== "cids.json")) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    let r = await pinJson(jwt, f, JSON.parse(text));
    if (r.status === 403) r = await pinFile(jwt, f, text); // clé sans pinJSONToIPFS : repli sur pinFileToIPFS
    if (!r.ok) throw new Error(`${f} : échec ${r.status} ${await r.text()}`);
    out[f] = (await r.json()).IpfsHash;
    console.log(f.padEnd(26), out[f]);
  }
  fs.writeFileSync(path.join(dir, "cids.json"), JSON.stringify(out, null, 2));
  console.log("\nÉcrit : frontend/metadata/cids.json — relancez le seed, puis faites une capture de Pinata > Files pour le rapport.");
}
main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });