# Scénario de test complet (local) : de la création de campagne à la détection de fraude

## Préparation
| Terminal | Commande | Rôle |
|---|---|---|
| 1 | `npm run node` | blockchain locale (1 bloc/s) |
| 2 | `npm run backend:seed` | déploie, crée 4 campagnes de démo, lance le robot ET la surveillance IA (toutes les 20 s) |
| 3 | `npm run web` | le site |
| 4 | (libre) | scripts de test |

Ouvrir `http://localhost:3000/frontend/index.html?dev=1` (Ctrl+F5). Le menu en haut à droite choisit le compte #0 à #19 sans MetaMask.
Comptes utiles : **#1** créateur, **#2** bénéficiaire, **#3, #9, #11, #12, #13** contributeurs, **#10** gros détenteur de CFD (13 000), **#17, #18, #19** propriétaires du multisig.

## Partie 1 : créer une campagne (compte #1)
1. Compte #1 → « Créer une campagne » : titre « Atelier test », objectif 3 ETH, 14 jours, 2 tranches, bénéficiaire = adresse du compte #2 (menu des comptes, ou `npx hardhat node` affiche les adresses).
2. Validez. Attendu : la campagne apparaît dans « Campagnes » et « Mes projets » ; cloche de #1 : « Votre campagne … est en ligne » (ligne « Pour vous »).
3. Autre compte (#3) : la cloche indique « Nouvelle campagne : Atelier test ».
Remarque : sans clé Pinata, les métadonnées sont stockées dans le navigateur ; avec `npm run pin` elles sont sur IPFS.

## Partie 2 : contributions normales (comptes #3, #9, #11, #12, #13)
1. #3 contribue 1 ETH, #9 1,2 ETH, #11 0,8 ETH, #12 0,05 ETH, #13 0,33 ETH (montants différents = comportement organique).
2. Attendu : CFD reçus (1 ETH = 1000 CFD, verrouillés) dans « Mes contributions » ; la barre dépasse 100 % mais la campagne reste « En cours » jusqu'à la 1re tranche validée.
3. Cloche de #1 : « 0x… a contribué … ETH à Atelier test ».
4. Un créateur ne peut pas contribuer à sa propre campagne (#1 ou #2 → erreur « auto-financement »).
5. Contribution < 0,001 ETH → refusée.

## Partie 3 : l'IA ne se trompe pas sur une campagne saine
1. Attendre ~20 s (terminal 2). Dans le tableau, « Atelier test » (5 contributions) doit avoir un score FAIBLE (< 25). Pas de badge sur le site.
2. MoonRocket garde son badge « Risque IA ÉLEVÉ (≈92) ».

## Partie 4 : attaque simulée, détection en temps réel
1. Terminal 4 : `npx hardhat run scripts/demo-fraud.js --network localhost`.
2. **Sans recharger** (~25 s) : la campagne « FastMoon Coin » reçoit « Risque IA ÉLEVÉ (≈90) », une alerte rouge s'affiche, la cloche indique « Alerte IA ».
3. Ouvrir FastMoon : la liste des signaux (H1 montants identiques, H2 rafale, H3 adresses neuves, ligne « IA : probabilité … ») et le bouton « Proposer un gel » pré-rempli.

## Partie 5 : valider une tranche (vote → file → exécution → versement automatiques)
1. Compte #3 → Atelier test → proposer « Valider la tranche 1 » (il faut ≥ 10 CFD : OK).
2. Votez « Pour » avec #10 (13 000 CFD), #9 et #3. Gouvernance : texte « 1 CFD = 1 voix », quorum 10 %.
3. Attendre le vote (5 min) puis le timelock (2 min) (ou `$env:SECONDS=400; npm run advance`). Le robot passe seul : « Adoptée » → « En timelock » (2 min) → « Exécutée ». Aucun bouton à cliquer.
4. Attendu : la campagne devient « Réussie » ; le bénéficiaire (#2) reçoit tout seul 98 % de la tranche (cloche de #2 : « Vous avez reçu … ETH ») ; 2 % vont à la trésorerie multisig.
5. Refaire pour la tranche 2 : à la fin, les CFD des contributeurs sont déverrouillés automatiquement (cloche : « Vos … CFD sont déverrouillés »).

## Partie 6 : quorum (une minorité ne passe pas)
1. Sur une autre campagne, compte #13 (≈ 0,6 ETH de CFD) propose une tranche et vote seul « Pour ».
2. À la fin : « Rejetée » (ses voix < 10 % de l'offre de CFD).

## Partie 7 : gel d'une campagne frauduleuse + remboursements
1. Sur FastMoon : #10 propose « Geler la campagne » ; votez « Pour » avec #10 et #9.
2. Après le vote et le timelock, le robot exécute : statut « Annulée / gelée ».
3. Les contributeurs sont remboursés automatiquement (cloche : « remboursé de … ETH »), leurs CFD sont brûlés.

## Partie 8 : veto du multisig
1. Lancer une proposition (ex. tranche de « Atelier test » si pas encore faite, ou une nouvelle) et la faire adopter.
2. Terminal 4 AVANT la fin du vote : `npx hardhat run scripts/demo-veto.js --network localhost` (il attend l'état « En timelock », puis le multisig signe à 2).
3. Attendu : « 1 signature : refusé », puis la proposition passe à « Annulée (veto) ».
Le script attend lui-même l'état « En timelock » : la fenêtre de 2 min suffit. (Pour l'allonger : `$env:TIMELOCK_DELAY=600` avant `npm run backend:seed`.)

## Partie 9 : trésorerie multisig (plafond journalier)
1. Compte #17 → Trésorerie → proposer un paiement de 0,1 ETH vers #5 → exécuter : 1 signature suffit.
2. Second paiement de 0,1 ETH le même jour : l'interface indique « 2 signatures requises » ; #18 confirme, puis exécuter.
(L'interface ne gère que les envois d'ETH ; les appels de contrat sont testés par les scripts demo-veto et demo-pause.)

## Partie 10 : pause limitée à 7 jours
`npx hardhat run scripts/demo-pause.js --network localhost` → pause (2 signatures), contribution refusée, levée refusée avant 7 jours, puis levée par un compte ordinaire après 8 jours.

## Partie 11 : tests automatiques
`npx hardhat test` → 55 tests (dont fuzzing). `python -c "import json;print(open('analysis/reports/ml_metrics.json').read())"` pour les métriques de l'IA.