# Guide : MetaMask, OpenZeppelin, IPFS

## A. Lier la dApp à MetaMask

### A1. Réseau local Hardhat
1. Lancer `npx hardhat node` : la console affiche 20 comptes, leurs adresses et **clés privées** (comptes publics de test, sans valeur).
2. MetaMask → *Ajouter un réseau manuellement* (ou laisser la dApp le faire au clic sur « Connecter MetaMask ») :
   - Nom : `Hardhat Local` · RPC : `http://127.0.0.1:8545` · Chain ID : `31337` · Symbole : `ETH`
3. MetaMask → *Importer un compte* → coller la clé privée d'un compte du nœud (ex. `#1` pour un contributeur).
   Utiliser plusieurs comptes pour tester les rôles : un créateur, un bénéficiaire, 3+ votants (quorum).
4. Si MetaMask affiche une erreur de nonce après un redémarrage du nœud : *Paramètres → Avancé → Effacer les données de l'onglet d'activité*.

### A2. Sepolia
1. Basculer MetaMask sur *Sepolia* (afficher les réseaux de test dans les paramètres).
2. Obtenir des ETH de test via un faucet. Créer un compte **dédié aux tests**.
3. Déployer (`npx hardhat run scripts/deploy.js --network sepolia`), ouvrir la dApp, connecter MetaMask.

### A3. Comment la dApp parle à la chaîne
- `frontend/contracts.json` (généré par `deploy.js`) contient **adresses + ABI** issues de la compilation.
- Lectures : `ethers.JsonRpcProvider` (sans wallet). Écritures : `ethers.BrowserProvider(window.ethereum)` → `getSigner()` → contrats connectés au signer ; chaque transaction ouvre une confirmation MetaMask.
- `wallet_switchEthereumChain` / `wallet_addEthereumChain` forcent le bon réseau. Les erreurs `revert` personnalisées sont décodées en messages français.

## B. OpenZeppelin (utilisation dans le projet)
Installation : `npm install @openzeppelin/contracts` (déjà fait). Contrats utilisés :

| Contrat OZ | Utilisé pour |
|---|---|
| `ERC20`, `ERC20Permit` | jeton CFD standard |
| `ERC20Votes` | **checkpoints** de soldes → `getPastVotes` (snapshot anti flash-loan) |
| `AccessControl` | rôles `MINTER_ROLE`, `PAUSER_ROLE`, `GOVERNANCE_ROLE`, admin |
| `ReentrancyGuard` | `nonReentrant` sur contribute / refund / withdrawFunds / claimTokens / sweepFees / execute |
| `Pausable` | circuit breaker |

Pour partir de **OpenZeppelin Wizard** (https://wizard.openzeppelin.com) : choisir *ERC20* → cocher *Mintable, Votes, Permit, Access Control (Roles)* → copier le code, comparer avec `contracts/CFDToken.sol`. Le Wizard n'est qu'un point de départ : la logique de verrouillage et de mint par le Core est propre à ce projet.

Autres outils OpenZeppelin utiles (optionnels) : *Contracts Library* (docs.openzeppelin.com/contracts), *Defender* (surveillance/pause en production), *Governor* (alternative standard à `CrowdfundDAO`, voir ARCHITECTURE.md §6).

## C. Métadonnées IPFS (Pinata)
1. Créer un compte gratuit sur https://pinata.cloud → *API Keys* → générer un **JWT**.
2. Dans la dApp : bouton ⚙ → coller le JWT → *Enregistrer* (stocké uniquement dans le `localStorage` de votre navigateur).
3. À la création d'une campagne, le JSON {titre, description, catégorie, image} est épinglé sur IPFS et **seul le CID** est écrit on-chain (`metadataCid`).
4. Sans JWT, un repli local (`local:<id>`) est utilisé : suffisant pour une démo mono-navigateur, **pas** pour un déploiement partagé.