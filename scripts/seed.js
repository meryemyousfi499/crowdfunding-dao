// Peuple la blockchain locale avec des campagnes de démo (dont une campagne suspecte pour l'analyse IA).
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const { ethers } = hre;
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "../frontend/contracts.json")));
  const core = await ethers.getContractAt(cfg.abis.core, cfg.addresses.core);
  const token = await ethers.getContractAt(cfg.abis.token, cfg.addresses.token);
  const s = await ethers.getSigners();
  const DAY = 86400;
  const eth = (x) => ethers.parseEther(String(x));

  // 1) Campagnes de démo (métadonnées servies par frontend/metadata/<nom>.json via "file:<nom>")
  const demos = [
    ["solar-school", 12, 20, 3, s[1], s[2]],
    ["open-lab", 8, 30, 2, s[3], s[4]],
    ["river-cleanup", 5, 14, 2, s[5], s[6]],
    ["suspicious-token", 20, 10, 4, s[7], s[8]], // campagne « piège » pour la détection de fraude
  ];
  // Si `npm run pin` a été exécuté (clé Pinata), frontend/metadata/cids.json contient les VRAIS CID IPFS : on les utilise.
  const cidFile = path.join(__dirname, "../frontend/metadata/cids.json");
  const real = fs.existsSync(cidFile) ? JSON.parse(fs.readFileSync(cidFile)) : {};
  for (const [name, goal, days, ms, creator, benef] of demos) {
    const cid = real[name + ".json"] ? "ipfs://" + real[name + ".json"] : "file:" + name;
    await (await core.connect(creator).createCampaign(eth(goal), days * DAY, benef.address, cid, ms)).wait();
  }

  // 2) Contributions « organiques » (montants variés, dispersés)
  const organic = [[0, 3, 1.2], [0, 9, 0.8], [0, 10, 2.5], [0, 11, 0.37], [1, 9, 4.1], [1, 12, 1.05], [2, 10, 5.5], [2, 13, 0.6]];
  for (const [id, who, amt] of organic) await (await core.connect(s[who]).contribute(id, { value: eth(amt) })).wait();

  // 3) Campagne 3 : motif de type Sybil (montant identique répété, adresses fraîches, rafale de blocs)
  for (let i = 10; i <= 16; i++) {
    for (let r = 0; r < 2; r++) await (await core.connect(s[i]).contribute(3, { value: eth(2.5) })).wait();
  }

  console.log("Campagnes:", (await core.campaignCount()).toString());
  console.log("Exemple: CFD de s[10] =", ethers.formatEther(await token.balanceOf(s[10].address)));
}
main().catch((e) => { console.error(e); process.exitCode = 1; });