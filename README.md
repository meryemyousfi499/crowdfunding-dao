# CrowdFund DAO — financement participatif décentralisé à gouvernance par jeton

Mini-projet Blockchain (ENSA Béni Mellal, IA & Cybersécurité). Solidity 0.8.24 · OpenZeppelin 5 · Hardhat · Ethers.js v6 · MetaMask · IPFS · Python (détection de fraude).

```
contracts/   CFDToken (M1) · CrowdfundingCore (M2) · CrowdfundDAO (M3) · MultiSigTreasury · mocks/ReentrancyAttacker
test/        55 tests : unitaires, réentrance, snapshot, vote linéaire anti-Sybil, quorum « pour », veto du multisig, timelock, gel, multisig (seuil), keeper, fuzzing (fast-check)
scripts/     deploy.js · seed.js (données de démo) · advance-time.js
frontend/    dApp M4 (HTML/JS + Ethers.js, sans build; notifications.js = cloche 🔔 de notifications) · metadata/ (métadonnées de démo)
scripts/     backend.js · fund.js · dev.js · make-owners.js · pin-metadata.js (deploy + keeper + surveillance IA) · demo-fraud.js (attaque de test en direct)
analysis/    fraud_detector.py + ml_model.py (bonus IA hors-chaîne : web3.py + Pandas + Random Forest scikit-learn)
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
npx hardhat test                  # 55 tests doivent passer
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
| Vote | Poids = CFD au snapshot (vote linéaire, 1 CFD = 1 voix) · quorum = 10 % de l’offre en votes « pour » (+ plancher) · majorité simple · vote 5 min · timelock 2 min (paramétrables, voir `docs/ARCHITECTURE.md` §7) · veto du multisig |
| Pause | `PAUSER_ROLE` (multisig) suspend contributions, remboursements, retraits ; **limitée à 7 jours** : ensuite n'importe qui appelle `unpauseExpired()` |

⚠ Projet pédagogique, contrats **non audités par un tiers** : ne jamais utiliser de fonds réels.

## 8. Exécution automatique (keeper), trésorerie, IPFS
- **Keeper** : une blockchain ne se déclenche pas seule. `npm run keeper` (avec le nœud lancé) met en file puis exécute automatiquement les propositions adoptées. La DAO expose aussi `checkUpkeep/performUpkeep` (Chainlink Automation / Gelato). Le robot n'a aucun privilège.
- **Trésorerie multisig** : dApp → Gouvernance → « Ouvrir la trésorerie multisig » (`#/treasury`). En local, propriétaires = comptes #17, #18, #19 de `hardhat node` (à importer dans MetaMask).
- **IPFS** : ⚙ Paramètres IPFS → coller le JWT Pinata → « Tester la connexion ». Option « Avancé » du formulaire de création : coller un CID déjà épinglé.
- **Fuzzing** : `npm run test:fuzz`.
- **Mode test sans MetaMask (local uniquement)** : ouvrir `http://127.0.0.1:3000/frontend/?dev=1`. Un sélecteur en haut propose les 20 comptes Hardhat (#0…#19) ; les transactions partent sans pop-up ni problème de nonce. Utile pour dérouler tout le plan de test ; MetaMask n'est alors nécessaire que pour Sepolia.
- **Utiliser vos propres comptes MetaMask en local (sans importer de clé)** : `$env:ADDRS="0xVotreAdresse1,0xVotreAdresse2"; npm run fund` donne 100 ETH de test à ces adresses sur le nœud local. Pour que ce soient eux les propriétaires du multisig : `$env:MULTISIG_OWNERS="0xA,0xB,0xC"` avant `npm run deploy:local`.
- **Temps automatique en local** : `npx hardhat node` produit désormais un bloc par seconde, donc le temps de la chaîne suit l'horloge réelle. Fin de vote, timelock et keeper (`npm run keeper`) fonctionnent seuls ; `npm run advance` ne sert plus qu'à « sauter » de longues durées (campagne de 1 jour, etc.). Redémarrer le nœud après mise à jour de `hardhat.config.js`.
- **Tout en une commande (local)** : `npm run start:local` lance le nœud, déploie les contrats, démarre le keeper et le site (`$env:SEED=1` pour ajouter les campagnes de démo). Ouvrir ensuite http://127.0.0.1:3000/frontend/ ; Ctrl+C arrête tout.
- **Automatisation complète (keeper)** : `npm run keeper` (ou `npm run start:local`) fait tout seul : mise en file / exécution des propositions, versement des tranches validées, déblocage des CFD après livraison, remboursement des campagnes échouées ou gelées, transfert des frais vers la trésorerie. Les fonctions `payout`, `claimTokensFor`, `refundFor`, `sweepFees` sont publiques mais l'argent va TOUJOURS à son propriétaire (bénéficiaire, contributeur, trésorerie), jamais à l'appelant.  La dApp ne propose donc aucun bouton manuel pour ces étapes et se rafraîchit seule toutes les 4 s.

## Lancer en local : 3 terminals (recommandé)
| Terminal | Commande | Rôle |
|---|---|---|
| 1 | `npm run node` | Nœud Hardhat (affiche les 20 comptes et leurs clés), 1 bloc par seconde |
| 2 | `npm run backend` | Déploie les contrats puis lance le robot d'automatisation (keeper). `npm run backend:seed` ajoute les campagnes de démo |
| 3 | `npm run web` | Site : http://127.0.0.1:3000/frontend/ |

Toujours démarrer le terminal 1 en premier. Si vous redémarrez le terminal 1, relancez le terminal 2 (la chaîne est réinitialisée). `npm run start:local` fait les trois d'un coup.

## Sepolia : mêmes 3 rôles, sans nœud local
| Étape | Commande | Quand |
|---|---|---|
| Déployer | `npm run deploy:sepolia` | **Une seule fois** (ne pas redéployer à chaque session : les campagnes sont conservées sur la chaîne) |
| Robot | `npm run keeper:sepolia` | À laisser tourner pendant la démo (il paie le gas avec le compte du `.env`) |
| Site | `npm run web` | Comme en local ; MetaMask sur Sepolia |