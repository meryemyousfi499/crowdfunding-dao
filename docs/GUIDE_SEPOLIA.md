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
Paramètres par défaut (identiques en local et sur Sepolia) : vote 5 min, timelock 2 min, seuil de proposition 10 CFD, plancher de quorum 100 CFD, quorum 10 % de l'offre (votes « pour »), veto du multisig, multisig 2 sur 3, seuil d'1 signature jusqu'à 0,1 ETH. **Ne mettez rien dans `.env` pour ces paramètres** : toute valeur écrite là remplace le défaut (voir `.env.example`).

## 2bis. Les 3 propriétaires du multisig (obligatoire hors local)
Le déploiement exige 3 adresses **distinctes** (2 signatures sur 3). Le plus simple :
```powershell
npm run owners
```
Cela crée `owners.secret.json` (clés privées, ignoré par Git) et affiche la ligne à coller dans `.env` :
`MULTISIG_OWNERS=0x...,0x...,0x...`
- **Sauvegardez `owners.secret.json` à deux endroits** (gestionnaire de mots de passe + clé USB). Il faut 2 clés sur 3 pour agir : si vous en perdez 2, plus personne ne peut accorder un rôle, suspendre la plateforme ni opposer le veto (sur testnet, il suffit alors de redéployer).
- Pour signer depuis la page *Trésorerie*, importez un propriétaire dans MetaMask : *Importer un compte* → clé privée.
- Le déploiement transfère `DEFAULT_ADMIN_ROLE` **et** `PAUSER_ROLE` au multisig (la pause demande donc 2 signatures). Pour garder la pause au déployeur (réaction plus rapide, mais un seul compte peut suspendre) : `KEEP_PAUSER=1`.

## 3. Déployer (PowerShell)
```powershell
$env:USE_SOLCJS=1            # seulement si le téléchargement du compilateur est bloqué
npx hardhat run scripts/deploy.js --network sepolia
```
Le script affiche les 4 adresses et écrit `frontend/contracts.json` (réseau 11155111, RPC public, jamais votre URL privée).
Optionnel — données de démo : `npx hardhat run scripts/seed.js --network sepolia` (nécessite assez de comptes financés ; sinon créez vos campagnes depuis la dApp).

## 3bis. Épingler les métadonnées sur IPFS (vrais CID)
1. Pinata → *API Keys* → *New Key* → copiez le **JWT** dans `.env` : `PINATA_JWT=eyJ...`
2. `npm run pin` : envoie les 4 fichiers de `frontend/metadata/` et écrit `frontend/metadata/cids.json`.
3. `npm run backend:seed` (local) utilise alors `ipfs://<CID>` au lieu de `file:<nom>`. Faites une capture de *Pinata → Files* pour le rapport.

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
| Vote ou timelock trop longs (ex. « fin du vote dans 2 j 23 h ») | Votre `.env` contient `VOTING_PERIOD` / `TIMELOCK_DELAY` : supprimez ces lignes puis **redéployez** (valeurs immuables). Sur un vrai réseau on ne peut pas avancer le temps. |
| Métadonnées introuvables | Utilisez Pinata (Paramètres IPFS → *Tester la connexion*), sinon le titre n'est visible que dans votre navigateur. |