# Audit statique — Slither 

Commande : `slither . --exclude-dependencies --filter-paths node_modules` (détail brut : `docs/slither-report.json`). 102 détecteurs, contrats du projet uniquement.

| Gravité | Détecteur | Nb | Décision |
|---|---|---|---|
| High | — | 0 | — |
| Medium | `divide-before-multiply` (`CrowdfundingCore._trancheAmount`) | 1 | **Faux positif volontaire** : `base = raised / N` puis `raised − base × (N−1)` pour la dernière tranche, afin qu'elle absorbe le reste. Aucun wei n'est perdu : testé pour N = 1…5 avec un montant non divisible. |
| Low | `timestamp` | 10 | **Accepté** : échéances de campagne et de vote en jours/heures ; la manipulation (~quelques secondes) du validateur est négligeable. |
| Low | `reentrancy-benign` (`mocks/ReentrancyAttacker`) | 1 | **Sans objet** : contrat d'attaque de test, jamais déployé en production. |
| Info | `low-level-calls` | 4 | **Accepté** : `call{value}` recommandé à la place de `transfer` ; le résultat est vérifié, effets avant interaction, `nonReentrant`. |

Corrections apportées suite à l'audit interne (relecture + Slither) :
- Ajout du test d'invariance d'arrondi des tranches (ci-dessus).
- Mise à jour d'état *avant* chaque appel externe (`refund`, `withdrawFunds`, `execute`, `sweepFees`).
- Ajout de `checkUpkeep/performUpkeep` (DAO) : permissionless et revalidé on-chain (action inconnue → `InvalidAction`, état incorrect → `WrongState`) ; testé.
- Seuil `smallLimit` du multisig : tout appel de contrat (calldata non vide) exige toujours `required` signatures.
- Sécurisation de `contracts.json` : l'URL RPC privée du `.env` n'est jamais exportée.

> Exécutez Slither vous-même sur la version finale (et Mythril si possible) avant la soutenance et annexez la sortie à votre rapport. Aucun audit tiers n'a été réalisé.
