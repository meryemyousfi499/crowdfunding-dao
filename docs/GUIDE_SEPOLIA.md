# Déployer sur Sepolia (réseau de test public)

> À faire **sur votre machine** : il faut votre propre clé et des ETH de test. Utilisez un compte MetaMask **dédié aux tests** (jamais un compte avec de vrais fonds).

## 1. Préparer
1. **ETH de test** : récupérez ~0,2 SepoliaETH sur un faucet (https://www.alchemy.com/faucets/ethereum-sepolia, https://sepolia-faucet.pk910.de).
2. **Clé RPC** : créez un compte gratuit sur Alchemy ou Infura, créez une app « Ethereum Sepolia », copiez l'URL HTTPS.
3. **Clé privée du compte de test** : MetaMask → ⋮ du compte → *Détails du compte* → *Afficher la clé privée*.
4. **3 adresses pour le multisig** (vos 3 propriétaires, par ex. 3 comptes MetaMask de test).

## 2. Fichier `.env` (à la racine du projet, jamais partagé)
```
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/VOTRE_CLE
PRIVATE_KEY=0xVOTRE_CLE_PRIVEE_DE_TEST
MULTISIG_OWNERS=0xAdresse1,0xAdresse2,0xAdresse3
# Optionnel : vérifier le code sur Etherscan
ETHERSCAN_API_KEY=VOTRE_CLE_ETHERSCAN
```
Paramètres par défaut hors local : vote 3 jours, timelock 1 jour, seuil de proposition 100 CFD, quorum 5 votants, multisig 2 sur 3, seuil d'1 signature jusqu'à 0,1 ETH. Pour une démo plus rapide : `VOTING_PERIOD=600`, `TIMELOCK_DELAY=120`, `PROPOSAL_THRESHOLD_CFD=10`, `QUORUM_VOTERS=2` dans le `.env`.

## 3. Déployer (PowerShell)
```powershell
$env:USE_SOLCJS=1            # seulement si le téléchargement du compilateur est bloqué
npx hardhat run scripts/deploy.js --network sepolia
```
Le script affiche les 4 adresses et écrit `frontend/contracts.json` (réseau 11155111, RPC public, jamais votre URL privée).
Optionnel — données de démo : `npx hardhat run scripts/seed.js --network sepolia` (nécessite assez de comptes financés ; sinon créez vos campagnes depuis la dApp).

## 4. Vérifier le code sur Etherscan (optionnel, très apprécié en soutenance)
```powershell
npx hardhat verify --network sepolia ADRESSE_TOKEN
```
Pour les autres contrats, passez les mêmes arguments que le constructeur (voir `scripts/deploy.js`). Les adresses apparaissent sur https://sepolia.etherscan.io.

## 5. Lancer la dApp
```powershell
npm run web         # puis http://127.0.0.1:3000/frontend/
```
MetaMask : la dApp propose de passer sur **Sepolia** automatiquement. Chaque action coûte un peu de gas (ETH de test).

## 6. Exécution automatique (keeper) sur Sepolia
```powershell
npx hardhat run scripts/keeper.js --network sepolia
```
Laisse tourner dans un terminal : il met en file puis exécute les propositions adoptées. Pour une solution « sans machine allumée », enregistrez la DAO sur **Chainlink Automation** (https://automation.chain.link) en « Custom logic » : la DAO expose déjà `checkUpkeep`/`performUpkeep`.

## 7. Pièges fréquents
| Message | Cause / solution |
|---|---|
| `insufficient funds` | Pas assez de SepoliaETH sur le compte du `.env`. |
| `network sepolia not found` | `SEPOLIA_RPC_URL` ou `PRIVATE_KEY` manquant dans `.env`. |
| Timelock/vote trop longs pour une démo | Réduisez `VOTING_PERIOD` / `TIMELOCK_DELAY` **avant** le déploiement (immuables). Sur un vrai réseau on ne peut pas avancer le temps. |
| Métadonnées introuvables | Utilisez Pinata (Paramètres IPFS → *Tester la connexion*), sinon le titre n'est visible que dans votre navigateur. |
