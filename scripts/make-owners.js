// Génère 3 portefeuilles distincts pour le multisig 2-sur-3 (testnet uniquement).
//   npm run owners        -> affiche la ligne MULTISIG_OWNERS=... à coller dans .env
// Les clés privées sont écrites dans owners.secret.json (ignoré par Git) : SAUVEGARDEZ-LE en 2 endroits.
// Pour utiliser un propriétaire dans MetaMask : Importer un compte -> clé privée.
const { ethers } = require("ethers");
const fs = require("fs");
const file = require("path").join(__dirname, "..", "owners.secret.json");
if (fs.existsSync(file) && process.env.FORCE !== "1") {
  console.error("owners.secret.json existe déjà (vos clés actuelles). Relancez avec FORCE=1 pour les REMPLACER.");
  process.exit(1);
}
const ws = [1, 2, 3].map(() => ethers.Wallet.createRandom());
fs.writeFileSync(file, JSON.stringify(ws.map((w, i) => ({ owner: i + 1, address: w.address, privateKey: w.privateKey })), null, 2), { mode: 0o600 });
console.log("\nCollez cette ligne dans .env :\n");
console.log("MULTISIG_OWNERS=" + ws.map((w) => w.address).join(","));
console.log("\nClés privées enregistrées dans owners.secret.json — ne jamais les partager ni les envoyer sur Git.");
console.log("Règle : 2 clés sur 3 sont nécessaires. Rangez-les à des endroits différents (gestionnaire de mots de passe, clé USB, papier).\n");