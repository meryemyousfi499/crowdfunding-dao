// Démo locale : avance l'horloge de la blockchain. Usage: SECONDS=400 npx hardhat run scripts/advance-time.js --network localhost
const { network } = require("hardhat");
(async () => {
  const s = Number(process.env.SECONDS || 400);
  await network.provider.send("evm_increaseTime", [s]);
  await network.provider.send("evm_mine");
  console.log(`+${s}s (bloc miné)`);
})();
