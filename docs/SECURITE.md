# Analyse de sécurité

| # | Exigence / menace | Implémentation | Preuve (test) |
|---|---|---|---|
| 1 | **Réentrance** (SWC-107) | Checks-Effects-Interactions : `refund` met `contributionOf`/`lockedTokensOf` à 0 *avant* le `call`. `nonReentrant` sur `contribute`, `refund`, `withdrawFunds`, `claimTokens`, `sweepFees`, `execute` (DAO, multisig). | `sécurité : réentrance` — `ReentrancyAttacker` rappelle `refund()` depuis `receive()` ; la ré-entrée est rejetée, l'attaquant ne récupère que sa mise, la victime reste remboursable. |
| 2 | **Contrôle d'accès** (SWC-105/115) | `AccessControl` : `MINTER_ROLE` (Core seul), `GOVERNANCE_ROLE` (DAO seule), `PAUSER_ROLE`, `DEFAULT_ADMIN_ROLE`. `withdrawFunds` réservé au bénéficiaire ; `approveTranche`/`freezeCampaign` réservés à la DAO. | `seule la DAO…`, `seul le Core peut frapper…`, `NotBeneficiary` |
| 3 | **Circuit breaker** | `Pausable` : `pause()`/`unpause()` par `PAUSER_ROLE` ; bloque création, contribution, remboursement, retrait, frais, jetons. | `circuit breaker : pause bloque…` |
| 4 | **Multisignature 2-sur-3** | `MultiSigTreasury` : submit → confirm → execute, revoke, anti double exécution ; seuil `smallLimit` (envoi simple ≤ seuil : 1 signature ; au-delà ou appel de contrat : `required`, ex. 2 sur 3). Reçoit les frais (`sweepFees`). | `exige 2 confirmations sur 3` |
| 5 | **Gouvernance : prise de contrôle éclair / flash loan** | Snapshot via `ERC20Votes.getPastVotes(bloc de création − 1)` ; jetons verrouillés (non transférables) ; seuil pour proposer évalué au snapshot. | `snapshot : … n'ont aucun poids` |
| 6 | **Baleines** | Vote quadratique (√ solde) | `poids = racine carrée…` |
| 7 | **Exécution précipitée** | Timelock + quorum + expiration ; une proposition ouverte par (type, campagne) | `quorum, timelock, anti-spam` |
| 8 | **Rug pull** | Déblocage par tranches validées par la DAO ; gel + remboursement au prorata | `gel d'une campagne frauduleuse` |
| 9 | **Wash funding** | Le créateur/bénéficiaire ne peut pas contribuer à sa campagne ; contribution minimale | `refuse … auto-financement` |
| 10 | **Dépassements / arrondis** | Solidity ≥ 0.8 (checked math) ; dernière tranche absorbe le reste | `la somme des tranches == fonds levés` |
| 11 | **ETH forcé / réception directe** | Pas de `receive()`/`fallback` dans le Core ; comptabilité par variables (pas par `address(this).balance`) | `n'accepte pas d'ETH hors contribute()` |
| 12 | **DoS par destinataire hostile** | Modèle *pull* : chacun retire sa part ; pas de boucle sur des tableaux d'utilisateurs | revue de code |
| 13 | **Validation des entrées** | Erreurs personnalisées, bornes (durée 1 h–90 j, ≤ 5 tranches, CID ≤ 100 octets, description ≤ 500) | `rejette les paramètres invalides` |
| 14 | **Front-end** | Toute donnée on-chain/IPFS est échappée avant insertion HTML (anti-XSS) ; URLs d'image limitées à http(s)/ipfs ; pas de clé RPC privée dans `contracts.json` | revue de code |

## Fuzzing
Deux niveaux :
- `fuzzing léger (invariant de solvabilité)` : 20 contributions aléatoires puis remboursement de tous.
- **`test/Fuzz.test.js` (fast-check, `npm run test:fuzz`)** : séquences aléatoires d'actions (contribuer, attendre, rembourser, retirer…) ; après chaque séquence on vérifie les invariants I1 (le Core détient au moins ce qu'il doit), I2 (CFD en circulation = contributions non remboursées × 1000), I3 (aucun wei perdu). En cas d'échec, fast-check **réduit** la séquence au plus petit contre-exemple. Validé par *test de mutation* : en retirant volontairement la destruction des CFD dans `refund`, le test échoue et isole « contribuer → attendre → rembourser ».
- Ce n'est pas un fuzzer industriel (Echidna / Foundry), mais un scénario de propriétés reproductible.
