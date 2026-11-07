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
| M3 | `CrowdfundDAO.sol` | Propositions (valider tranche / geler), vote quadratique sur snapshot, quorum, timelock. |
| — | `MultiSigTreasury.sol` | Trésorerie 2-sur-3 recevant les frais. |
| M4 | `frontend/` | Liste/filtre/pagination des campagnes, détail, contribution, création (IPFS), tableau de vote, compte. |
| Bonus | `analysis/fraud_detector.py` | Heuristiques H1–H6, score 0–100, rapport CSV/JSON → badge dans la dApp. |

## 3. Choix justifiés
**Taux de frappe : 1 ETH = 1000 CFD.** Proportionnel à l'apport (exigence). Le facteur 1000 donne des soldes entiers lisibles pour les petites contributions : le minimum de 0,001 ETH rapporte 1 CFD, ce qui correspond à 1 voix au carré minimal (√1). Taux fixe et identique pour toutes les campagnes : un jeton représente « 0,001 ETH confié à la plateforme », sans prime pour les premiers entrants.

**Jetons verrouillés.** Un CFD reçu pour une campagne non livrée ne peut pas être revendu (sinon on conserverait du pouvoir de vote sans risque après remboursement, ou on vendrait un jeton adossé à une campagne qui échouera). Les jetons restent *votants* mais non transférables ; `claimTokens` les libère quand toutes les tranches sont versées ; `refund` les brûle.

**Cycle de vie.** `Active` → `Successful` (objectif atteint à l'échéance, ou déblocage anticipé voté par la DAO) / `Failed` (objectif manqué) ; `Canceled` (annulation d'une campagne vide par son créateur, ou gel DAO). Le passage `Active → Successful/Failed` est calculé à la volée (`effectiveStatus`) et persisté paresseusement (`_sync`) par la première transaction qui en a besoin : aucune clé « keeper » n'est nécessaire.

**Tranches.** Le total levé est divisé en N tranches (1–5) ; la dernière absorbe le reste de la division (aucun wei perdu, testé). Le bénéficiaire ne peut retirer que les tranches validées par la DAO (`withdrawFunds`). Une campagne gelée après un retrait partiel rembourse **au prorata de ce qui reste** (`contribution × (levé − retiré) / levé`).

**Gouvernance.**
- *Pouvoir de vote* = `floor(√(CFD entiers au snapshot))`. Snapshot = bloc précédant la création de la proposition (`getPastVotes`), pas le bloc du vote.
- *Majorité* : pour > contre (simple). *Quorum* : nombre minimal de **votants distincts** (2 en local, 5 sur testnet) — choisi en nombre de votants plutôt qu'en part de l'offre car le poids quadratique n'est pas additif sur la masse de jetons.
- *Timelock* : `queue` puis attente `timelockDelay` avant `execute` ; expiration après 7 jours (`GRACE_PERIOD`). Exécution déclenchable par n'importe qui (« exécution automatique » sans administrateur).
- *Anti-spam* : seuil de CFD pour proposer, une proposition ouverte par (type, campagne), description ≤ 500 caractères.

**Pourquoi pas OpenZeppelin Governor ?** Governor est un excellent standard, mais la DAO ici doit appeler un Core précis, avec un vote quadratique et des règles spécifiques ; l'écrire à la main permet de la comprendre et de la défendre en soutenance. Migrer vers Governor + `GovernorVotesQuorumFraction` + `TimelockController` est la suite logique en production.

**Pourquoi Hardhat ?** JavaScript/Ethers.js identique à la dApp, plugins (toolbox, network-helpers `time`/`mine` indispensables pour tester le snapshot et le timelock), nœud local avec 20 comptes, intégration Slither.

## 4. Limites connues (assumées)
1. **Sybil** : le vote quadratique favorise le fractionnement des fonds sur plusieurs adresses. Atténuations : contribution minimale, jetons verrouillés, quorum en nombre de votants, détection hors-chaîne (H3). Une vraie protection exige une preuve d'identité.
2. **Droits d'administration** : le déployeur garde `DEFAULT_ADMIN_ROLE` sur le jeton et le Core (il peut accorder `MINTER_ROLE`/`GOVERNANCE_ROLE`). En production : transférer ce rôle à un multisig/timelock puis le retirer au déployeur.
3. **Vote global** : tous les détenteurs de CFD votent sur toutes les campagnes (pas seulement les contributeurs de la campagne concernée).
4. **Multisig** : la trésorerie ne contient que les frais ; un envoi simple ≤ 0,1 ETH (`smallLimit`) n'exige qu'1 signature, au-delà (ou tout appel de contrat) il en faut 2 sur 3. Interface : page *Trésorerie* de la dApp (`#/treasury`).
5. **Pause** : le circuit breaker suspend aussi `refund` (compromis assumé : arrêt total en cas d'incident ; la reprise doit être rapide).
6. **Détection IA** : heuristiques simples, faux positifs possibles ; le script ne modifie jamais la chaîne, la décision reste à la DAO.
7. Contrats non audités par un tiers ; durée max. 90 jours ; ETH uniquement (pas d'ERC-20 de paiement).
