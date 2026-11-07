# CrowdFund DAO — financement participatif décentralisé à gouvernance par jeton

Mini-projet Blockchain (ENSA Béni Mellal, IA & Cybersécurité). Solidity 0.8.24 · OpenZeppelin 5 · Hardhat · Ethers.js v6 · MetaMask · IPFS · Python (détection de fraude).

```
contracts/   CFDToken (M1) · CrowdfundingCore (M2) · CrowdfundDAO (M3) · MultiSigTreasury · mocks/ReentrancyAttacker
test/        33 tests : unitaires, réentrance, snapshot, quadratique, timelock, gel, multisig (seuil), keeper, fuzzing (fast-check)
scripts/     deploy.js · seed.js (données de démo) · advance-time.js
frontend/    dApp M4 (HTML/JS + Ethers.js, sans build) · metadata/ (métadonnées de démo)
analysis/    fraud_detector.py (bonus IA hors-chaîne : web3.py + Pandas)
docs/        ARCHITECTURE.md · SECURITE.md · AUDIT.md · GUIDE_METAMASK_OPENZEPPELIN.md · slither-report.json
```

## 1. Prérequis
Node.js ≥ 18 (testé 22), npm, Python ≥ 3.10, MetaMask (extension navigateur).

## 2. Installation
```bash
unzip crowdfund-dao.zip && cd crowdfunding-dao
npm install
pip install -r analysis/requirements.txt        # pour le script Python (ajouter --break-system-packages si nécessaire)
```

## 3. Compiler et tester
```bash
npx hardhat compile
npx hardhat test                  # 29 tests doivent passer
```
> Réseau sans accès à `binaries.soliditylang.org` ? Utilisez le compilateur npm : `USE_SOLCJS=1 npx hardhat test` (ou `npm run test:offline`).

## 4. Démo en local (blockchain Hardhat) — 4 terminaux
```bash
# Terminal 1 — blockchain locale (20 comptes de test avec 10 000 ETH, chainId 31337)
npx hardhat node

# Terminal 2 — déploiement + données de démo
npx hardhat run scripts/deploy.js --network localhost     # écrit frontend/contracts.json (adresses + ABI)
npx hardhat run scripts/seed.js   --network localhost     # 4 campagnes dont une suspecte

# Terminal 3 — interface web
python3 -m http.server 3000                               # depuis la racine du projet
# ouvrir http://localhost:3000/frontend/

# Terminal 4 — analyse IA hors-chaîne (lit les événements de la chaîne)
python3 analysis/fraud_detector.py                        # écrit analysis/reports/fraud_report.{csv,json}
# puis rafraîchir la dApp : les campagnes à risque affichent un badge « ⚠ Risque IA »
```
Avancer l'horloge locale (fin de campagne, vote, timelock) : `SECONDS=400 npx hardhat run scripts/advance-time.js --network localhost`.

## 5. Connexion à MetaMask
Voir **docs/GUIDE_METAMASK_OPENZEPPELIN.md** (étapes détaillées, import des comptes de test, réseau Sepolia, IPFS/Pinata).
Résumé : cliquer sur « Connecter MetaMask » → la dApp ajoute/sélectionne automatiquement le réseau (31337 local ou Sepolia) → importer un compte de test dans MetaMask avec la clé privée affichée par `npx hardhat node`.

## 6. Déploiement Sepolia  (guide complet : **docs/GUIDE_SEPOLIA.md**)
```bash
cp .env.example .env     # renseigner SEPOLIA_RPC_URL (Infura/Alchemy) et PRIVATE_KEY (compte de TEST avec des ETH Sepolia)
npx hardhat run scripts/deploy.js --network sepolia
# MULTISIG_OWNERS="0xA,0xB,0xC" avant la commande pour un vrai multisig 2-sur-3
python3 -m http.server 3000   # puis http://localhost:3000/frontend/ avec MetaMask sur Sepolia
```
Faucets Sepolia : https://sepoliafaucet.com · https://www.alchemy.com/faucets/ethereum-sepolia

## 7. Audit statique
```bash
pip install slither-analyzer && slither . --exclude-dependencies --filter-paths node_modules
```
Résultats et corrections : **docs/AUDIT.md**.

## 8. Règles métier en bref
| Sujet | Règle |
|---|---|
| Taux CFD | 1 ETH = 1000 CFD, frappés à la contribution, **verrouillés** jusqu'à la livraison complète ; brûlés au remboursement |
| Statuts | Active → Réussie / Échouée (à l'échéance) ; Annulée (campagne vide annulée ou gel DAO) |
| Retrait | Par tranches (1–5), chacune validée par un vote DAO ; 2 % de frais → trésorerie multisig 2/3 |
| Vote | Poids = √(CFD au snapshot) · quorum = nb. minimal de votants · majorité simple · timelock avant exécution |
| Pause | `PAUSER_ROLE` suspend contributions, remboursements, retraits, jetons |

⚠ Projet pédagogique, contrats **non audités par un tiers** : ne jamais utiliser de fonds réels.

## 8. Exécution automatique (keeper), trésorerie, IPFS
- **Keeper** : une blockchain ne se déclenche pas seule. `npm run keeper` (avec le nœud lancé) met en file puis exécute automatiquement les propositions adoptées. La DAO expose aussi `checkUpkeep/performUpkeep` (Chainlink Automation / Gelato). Le robot n'a aucun privilège.
- **Trésorerie multisig** : dApp → Gouvernance → « Ouvrir la trésorerie multisig » (`#/treasury`). En local, propriétaires = comptes #17, #18, #19 de `hardhat node` (à importer dans MetaMask).
- **IPFS** : ⚙ Paramètres IPFS → coller le JWT Pinata → « Tester la connexion ». Option « Avancé » du formulaire de création : coller un CID déjà épinglé.
- **Fuzzing** : `npm run test:fuzz`.
