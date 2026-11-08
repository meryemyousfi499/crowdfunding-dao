# Scénario de test complet (local) — modifications récentes

Terminaux (dans le dossier du projet) :
1. `npm run node`            (blockchain, à laisser ouvert)
2. `npm run backend:seed`    (déploie, crée 4 campagnes, lance le robot ET la surveillance IA toutes les 20 s)
3. `npm run web`             puis http://localhost:3000/frontend/index.html?dev=1  (Ctrl+F5)

## T0. Tests automatiques
`npx hardhat test` → 55 tests verts (ou 54 si vous gardez votre DAO.test.js).

## T1. Alertes IA en temps réel (nouveau)
1. Page d'accueil : MoonRocket affiche « ⚠ Risque IA ÉLEVÉ (≈92) » (le terminal 2 l'a calculé).
2. Terminal 4 : `npx hardhat run scripts/demo-fraud.js --network localhost` (16 versements identiques d'adresses neuves).
3. SANS recharger : sous ~25 s, une 2e campagne « FastMoon Coin » reçoit le badge ÉLEVÉ (≈90), une alerte rouge apparaît en bas à droite et la cloche 🔔 affiche « Alerte IA ».
4. Terminal 2 : le rapport détaillé (H1, H2, H3, IA…) est réaffiché seulement quand quelque chose change.
✔ Si OK : détection continue + notification.

## T2. Cloche de notifications
1. Compte #3 : contribuez 0,05 ETH à une campagne. Changez de compte (menu #…) → la cloche indique la contribution.
2. Compte créateur de la campagne : ligne « Pour vous ».
3. « Tout marquer comme lu » → le badge disparaît.

## T3. Vote linéaire + quorum 10 % + veto
1. Gouvernance : texte « 1 CFD = 1 voix », « quorum 10 % ».
2. Un compte avec ≥ 10 CFD propose « Valider la tranche » sur une campagne réussie. Votez « pour » avec 2 comptes ayant des CFD.
3. Avec un seul petit compte (< 10 % de l'offre) : à la fin du vote → « Rejetée » (quorum non atteint).
4. Avancez le temps si besoin : `npm run advance`. Le robot met en file puis exécute tout seul.
5. Veto : pendant l'état « En timelock », Trésorerie → propriétaire #17 propose `cancel(id, "raison")` sur le DAO, #18 confirme → la proposition passe « Annulée (veto) ».

## T4. Multisig : plafond journalier
1. Trésorerie (compte #17) : envoi de 0,1 ETH → 1 signature suffit.
2. Second envoi de 0,1 ETH le même jour → « 2 signatures requises » ; #18 confirme puis exécutez.

## T5. Pause limitée à 7 jours
1. (Avec le compte PAUSER : en local c'est le multisig) pause via la Trésorerie (appel `pause()` du Core, 2 signatures).
2. Contribuer échoue. `npm run advance` (8 jours) puis n'importe quel compte appelle `unpauseExpired()` → la plateforme repart.

## T6. IPFS
`npm run pin` (PINATA_JWT dans .env) puis `npm run backend:seed` : les titres s'affichent depuis `ipfs://CID` ; Pinata → Files montre 4 fichiers.

## T7. MetaMask non bloquant
Désactivez MetaMask : la page doit s'afficher quand même ; « Connecter » affiche un message d'aide.