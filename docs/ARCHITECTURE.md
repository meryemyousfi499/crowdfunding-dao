# Architecture

## 1. Vue d'ensemble
```
 Contributeur ──ETH──▶ CrowdfundingCore ──mintLocked──▶ CFDToken (ERC20Votes)
        ▲                   │  ▲                              │ checkpoints (snapshot)
        │ refund/claim      │  │ approveTranche / freeze      ▼
        │                   │  └────────────── CrowdfundDAO ◀─ getPastVotes
 Bénéficiaire ◀─ tranche ───┘        (propose → vote → queue → timelock → execute)
        frais 2 % ──▶ MultiSigTreasury (2 sur 3)
 dApp (Ethers.js + MetaMask)  ·  IPFS (métadonnées, hash seul on-chain)  ·  fraud_detector.py (hors-chaîne)
```

## 2. Modules
| Module | Fichier | Rôle |
|---|---|---|
| M1 | `CFDToken.sol` | ERC-20 « CFD » + ERC20Votes/Permit. Seul `MINTER_ROLE` (le Core) peut frapper, déverrouiller, brûler. |
| M2 | `CrowdfundingCore.sol` | Campagnes, contributions, statuts, remboursement, retraits par tranches, frais, pause. |
| M3 | `CrowdfundDAO.sol` | Propositions (valider tranche / geler), vote linéaire sur snapshot, quorum sur les votes « pour », timelock, veto du multisig. |
| — | `MultiSigTreasury.sol` | Trésorerie 2-sur-3 recevant les frais. |
| M4 | `frontend/` | Liste/filtre/pagination des campagnes, détail, contribution, création (IPFS), tableau de vote, compte. |
| Bonus | `analysis/fraud_detector.py` | Heuristiques H1–H6, score 0–100, rapport CSV/JSON → badge dans la dApp. |

## 3. Choix justifiés
**Taux de frappe : 1 ETH = 1000 CFD.** Proportionnel à l'apport (exigence). Le facteur 1000 donne des soldes entiers lisibles pour les petites contributions : le minimum de 0,001 ETH rapporte 1 CFD, ce qui correspond à 1 voix au carré minimal (√1). Taux fixe et identique pour toutes les campagnes : un jeton représente « 0,001 ETH confié à la plateforme », sans prime pour les premiers entrants.

**Jetons verrouillés.** Un CFD reçu pour une campagne non livrée ne peut pas être revendu (sinon on conserverait du pouvoir de vote sans risque après remboursement, ou on vendrait un jeton adossé à une campagne qui échouera). Les jetons restent *votants* mais non transférables ; `claimTokens` les libère quand toutes les tranches sont versées ; `refund` les brûle.

**Cycle de vie.** `Active` → `Successful` (objectif atteint à l'échéance, ou déblocage anticipé voté par la DAO) / `Failed` (objectif manqué) ; `Canceled` (annulation d'une campagne vide par son créateur, ou gel DAO). Le passage `Active → Successful/Failed` est calculé à la volée (`effectiveStatus`) et persisté paresseusement (`_sync`) par la première transaction qui en a besoin : aucune clé « keeper » n'est nécessaire.

**Tranches.** Le total levé est divisé en N tranches (1–5) ; la dernière absorbe le reste de la division (aucun wei perdu, testé). Le bénéficiaire ne peut retirer que les tranches validées par la DAO (`withdrawFunds`). Une campagne gelée après un retrait partiel rembourse **au prorata de ce qui reste** (`contribution × (levé − retiré) / levé`).

**Gouvernance.**
- *Pouvoir de vote* = `floor(CFD entiers au snapshot)` (vote linéaire : 1 CFD = 1 voix). Snapshot = bloc précédant la création de la proposition (`getPastVotes`), pas le bloc du vote.
- *Majorité* : pour > contre (simple). *Quorum* : les votes **« pour »** doivent représenter au moins `quorumBps` de l'offre de CFD au snapshot (1000 = 10 %) **et** au moins `minQuorum` CFD (plancher absolu contre les attaques au démarrage, quand l'offre est minuscule). *Maturité du snapshot* : le snapshot est pris `snapshotLookback` blocs avant la proposition (contribuer puis proposer aussitôt ne donne aucun poids). Les jetons étant verrouillés et proportionnels aux ETH engagés, fractionner ses fonds sur plusieurs adresses ne donne aucun avantage (anti-Sybil) et un attaquant minoritaire seul ne peut pas atteindre le quorum.
- *Timelock* : `queue` puis attente `timelockDelay` avant `execute` ; expiration après 7 jours (`GRACE_PERIOD`). *Veto* : pendant le timelock, le `guardian` (= le multisig 2-sur-3) peut annuler une proposition adoptée via `cancel(id)` ; il ne peut qu'annuler (jamais approuver ni exécuter) et l'annulation est publique (`ProposalCanceled`). Exécution déclenchable par n'importe qui (« exécution automatique » sans administrateur).
- *Anti-spam* : seuil de CFD pour proposer, une proposition ouverte par (type, campagne), description ≤ 500 caractères.

**Pourquoi pas OpenZeppelin Governor ?** Governor est un excellent standard, mais la DAO ici doit appeler un Core précis, avec un vote linéaire, un quorum sur les votes « pour » et un veto du multisig ; l'écrire à la main permet de la comprendre et de la défendre en soutenance. Migrer vers Governor + `GovernorVotesQuorumFraction` + `TimelockController` est la suite logique en production.

**Pourquoi Hardhat ?** JavaScript/Ethers.js identique à la dApp, plugins (toolbox, network-helpers `time`/`mine` indispensables pour tester le snapshot et le timelock), nœud local avec 20 comptes, intégration Slither.

## 4. Limites connues (assumées)
1. **Pouvoir des gros détenteurs** : le vote est linéaire, donc un contributeur détenant plus de `quorumBps` de l'offre pèse lourd. Le fractionnement en adresses multiples n'apporte plus d'avantage (Sybil neutralisé) ; atténuations : quorum sur les votes « pour », timelock, veto du multisig, détection hors-chaîne (H3).
2. **Droits d'administration** : `deploy.js` transfère `DEFAULT_ADMIN_ROLE` (jeton et Core) au multisig puis le retire au déployeur (sauf `KEEP_ADMIN=1`), ainsi que `PAUSER_ROLE` (sauf `KEEP_PAUSER=1`) ; hors local, il refuse un multisig plus faible que 2-sur-3 (sauf `ALLOW_WEAK_MULTISIG=1`).
3. **Vote global** : tous les détenteurs de CFD votent sur toutes les campagnes (pas seulement les contributeurs de la campagne concernée).
4. **Multisig** : la trésorerie ne contient que les frais ; un envoi simple ≤ 0,1 ETH (`smallLimit`) n'exige qu'1 signature, au-delà (ou tout appel de contrat) il en faut 2 sur 3. Interface : page *Trésorerie* de la dApp (`#/treasury`).
5. **Perte de clés du multisig** : si 2 clés sur 3 sont perdues, plus personne ne peut accorder de rôle, ni mettre en pause, ni exercer le veto. Mesure : `npm run owners` génère 3 clés à sauvegarder à des endroits distincts ; pas de remplacement de propriétaire dans le contrat (piste d'amélioration).
6. **Pause** (2 signatures, donc un peu moins réactive) : le circuit breaker suspend aussi `refund` (compromis assumé : arrêt total en cas d'incident ; la reprise doit être rapide).
6. **Détection IA** : heuristiques simples, faux positifs possibles ; le script ne modifie jamais la chaîne, la décision reste à la DAO.
7. Contrats non audités par un tiers ; durée max. 90 jours ; ETH uniquement (pas d'ERC-20 de paiement).

## 5. Trésorerie, pause, tests de propriétés, IPFS (durcissements)
- **Rôle du multisig** : la trésorerie de l'organisation = les frais de 2 %. Les fonds des campagnes sont protégés par le vote DAO, le timelock et le versement par tranches ; le multisig 2-sur-3 protège la trésorerie **et** l'administration (rôles, pause, veto).
- **Anti-drainage** : un envoi simple ≤ `smallLimit` n'exige qu'1 signature, mais le total de ces envois est plafonné à `smallLimit` par jour (`smallSpentOnDay`). Le second envoi du jour exige `required` signatures.
- **Pause** : compromis assumé entre sécurité d'urgence et censure. Après `MAX_PAUSE` (7 jours), n'importe qui lève la pause.
- **Tests de propriétés (property-based testing, fast-check)** avec invariants : solvabilité du Core, cohérence des CFD, et « somme des poids de vote ≤ offre au snapshot ». Suite naturelle en production : Echidna ou Foundry.
- **IPFS** : `npm run pin` épingle `frontend/metadata/*.json` sur Pinata et écrit les vrais CID dans `frontend/metadata/cids.json` ; `seed.js` utilise alors `ipfs://<CID>`.

## 6. Couche IA de la détection de fraude (`analysis/ml_model.py`)
- **Pourquoi** : le cahier des charges demande une IA au service de la blockchain (détection de fraude). Les heuristiques H1–H6 sont explicables mais fixes ; le modèle apprend la combinaison de signaux.
- **Modèle** : Random Forest (scikit-learn) sur 12 caractéristiques par campagne (diversité des adresses, concentration, montants répétés/ronds, rafales, rapidité d'atteinte de l'objectif, cercle fermé…). Score final = 50 % heuristiques + 50 % probabilité du modèle.
- **Données d'entraînement** : campagnes **simulées** et étiquetées (600 organiques dont des cas difficiles « innocents », 300 frauduleuses : Sybil, wash-funding, baleine/dump, dont des variantes furtives). Aucune fraude réelle étiquetée n'existe sur la plateforme : limite assumée.
- **Évaluation honnête** (`analysis/reports/ml_metrics.json`) : validation croisée 5 plis (précision/rappel ≈ 0,99 sur la simulation, donc optimiste car le simulateur définit les classes) et test de généralisation « un type de fraude jamais vu » : rappel ≈ 0,90 (Sybil) et 0,93 (baleine) mais **0 %** pour le wash-funding non vu en entraînement. Le modèle ne détecte donc que ce qui ressemble à ce qu'il a appris.
- **Garde-fou** : sous 5 contributions, pas de score ML (données insuffisantes) ; seules les heuristiques s'appliquent.
- **Perspectives** : ré-entraîner avec les gels réellement votés par la DAO, ajouter les votes (`VoteCast`), Isolation Forest non supervisé, graphe d'adresses.