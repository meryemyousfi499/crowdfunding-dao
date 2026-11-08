// SCÉNARIO DE TEST EN DIRECT : simule une attaque Sybil sur une nouvelle campagne.
// Lancez-le pendant que la surveillance IA tourne (npm run backend) : au bout de ~20 s, le badge
// « Risque IA ÉLEVÉ » apparaît tout seul sur la campagne et la cloche 🔔 vous alerte.
const { ethers } = require("hardhat");
const cfg = require("../frontend/contracts.json");
(async () => {
  const s = await ethers.getSigners();
  const core = await ethers.getContractAt(cfg.abis.core, cfg.addresses.core);
  const day = 86400;
  await (await core.connect(s[14]).createCampaign(ethers.parseEther("12"), 10 * day, s[15].address, "file:live-demo-fraud", 3)).wait();
  const id = Number(await core.campaignCount()) - 1;
  console.log(`Campagne #${id} créée. Attaque : 8 adresses neuves x 2 versements identiques de 0,75 ETH...`);
  for (let round = 0; round < 2; round++)
    for (let i = 3; i <= 10; i++) await (await core.connect(s[i]).contribute(id, { value: ethers.parseEther("0.75") })).wait();
  console.log(`Fait : 16 contributions identiques en quelques blocs. Surveillez la page d'accueil et la cloche.`);
})().catch((e) => { console.error(e); process.exit(1); });