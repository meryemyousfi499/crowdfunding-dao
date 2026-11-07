// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {CFDToken} from "./CFDToken.sol";
import {ICrowdfundingCore} from "./interfaces/ICrowdfundingCore.sol";

/**
 * @title CrowdfundingCore
 * @notice Cœur de la plateforme : campagnes, contributions en ETH, remboursements et retraits
 *         par tranches (« milestones ») validées par la DAO.
 *
 * Mesures de sécurité (voir docs/SECURITE.md) :
 *  - Anti-reentrance : Checks-Effects-Interactions + ReentrancyGuard sur contribute / refund /
 *    withdrawFunds / claimTokens / sweepFees.
 *  - Contrôle d'accès : AccessControl. DEFAULT_ADMIN_ROLE (gestion des rôles), PAUSER_ROLE
 *    (circuit breaker), GOVERNANCE_ROLE (accordé UNIQUEMENT au contrat DAO).
 *  - Circuit breaker : Pausable, suspend contributions, remboursements, retraits et jetons.
 *  - Retraits « pull » : ni les frais ni les fonds ne sont poussés automatiquement à une adresse
 *    tierce ; chaque bénéficiaire retire lui-même (évite le blocage par un destinataire hostile).
 *  - Aucune fonction receive()/fallback() : l'ETH n'entre que par contribute().
 */
contract CrowdfundingCore is ICrowdfundingCore, AccessControl, ReentrancyGuard, Pausable {
    // ------------------------------------------------------------------ rôles
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");

    // ------------------------------------------------------------- paramètres
    /// @notice Taux de frappe : 1 ETH contribué = 1000 CFD (soit 1 wei -> 1000 unités de base).
    uint256 public constant TOKENS_PER_ETH = 1000;
    /// @notice Frais de plateforme prélevés sur chaque tranche retirée (2 %), versés à la trésorerie multisig.
    uint256 public constant FEE_BPS = 200;
    uint256 public constant BPS = 10_000;
    uint256 public constant MIN_CONTRIBUTION = 0.001 ether;
    uint256 public constant MIN_DURATION = 1 hours;
    uint256 public constant MAX_DURATION = 90 days;
    uint8 public constant MAX_MILESTONES = 5;
    uint256 public constant MAX_CID_LENGTH = 100;

    // ------------------------------------------------------------------ données
    struct Campaign {
        address creator;
        address beneficiary;
        uint256 goal;
        uint256 deadline;
        uint256 raised;
        uint256 withdrawn; // montant brut déjà sorti vers le bénéficiaire (frais inclus)
        uint8 milestones; // nombre de tranches
        uint8 tranchesApproved; // tranches validées par la DAO
        uint8 tranchesWithdrawn; // tranches effectivement retirées
        Status status;
        string metadataCid; // hash IPFS des métadonnées (seul le hash est stocké on-chain)
    }

    CFDToken public immutable token;
    address public immutable treasury;

    Campaign[] private _campaigns;
    mapping(uint256 => mapping(address => uint256)) public contributionOf; // id => user => wei
    mapping(uint256 => mapping(address => uint256)) public lockedTokensOf; // id => user => CFD verrouillés
    uint256 public accruedFees;
    /// @dev Liste des contributeurs par campagne (alimentée à la 1re contribution) : permet au robot d'automatiser remboursements et déblocages.
    mapping(uint256 => address[]) private _contributors;

    // ------------------------------------------------------------------ erreurs
    error CampaignNotFound(uint256 id);
    error InvalidParameters();
    error CampaignNotActive();
    error ContributionTooLow();
    error SelfFunding();
    error NotRefundable();
    error NothingToRefund();
    error NotBeneficiary();
    error NotCreator();
    error NoTrancheAvailable();
    error GoalNotReached();
    error InvalidStatus(Status current);
    error NotYetDelivered();
    error NothingToClaim();
    error NoFees();
    error TransferFailed();
    error CampaignHasFunds();

    // ------------------------------------------------------------------ événements
    event CampaignCreated(
        uint256 indexed id,
        address indexed creator,
        address indexed beneficiary,
        uint256 goal,
        uint256 deadline,
        uint8 milestones,
        string metadataCid
    );
    event Contributed(uint256 indexed id, address indexed contributor, uint256 amount, uint256 tokensMinted);
    event StatusChanged(uint256 indexed id, Status status);
    event Refunded(uint256 indexed id, address indexed contributor, uint256 amount, uint256 tokensBurned);
    event TrancheApproved(uint256 indexed id, uint8 trancheIndex);
    event FundsWithdrawn(uint256 indexed id, address indexed beneficiary, uint256 net, uint256 fee, uint8 trancheIndex);
    event CampaignFrozen(uint256 indexed id);
    event TokensClaimed(uint256 indexed id, address indexed contributor, uint256 amount);
    event FeesSwept(address indexed treasury, uint256 amount);

    constructor(CFDToken token_, address treasury_, address admin) {
        if (address(token_) == address(0) || treasury_ == address(0) || admin == address(0)) revert InvalidParameters();
        token = token_;
        treasury = treasury_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    // =====================================================================
    //  Administration (circuit breaker)
    // =====================================================================

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // =====================================================================
    //  Création & contribution
    // =====================================================================

    /**
     * @notice Crée une campagne.
     * @param goal Objectif en wei.
     * @param duration Durée en secondes (MIN_DURATION .. MAX_DURATION).
     * @param beneficiary Adresse qui percevra les fonds (par tranches validées par la DAO).
     * @param metadataCid Hash IPFS (titre, description, image…).
     * @param milestones Nombre de tranches de déblocage (1..MAX_MILESTONES).
     */
    function createCampaign(
        uint256 goal,
        uint256 duration,
        address beneficiary,
        string calldata metadataCid,
        uint8 milestones
    ) external whenNotPaused returns (uint256 id) {
        if (
            goal == 0 || beneficiary == address(0) || duration < MIN_DURATION || duration > MAX_DURATION
                || milestones == 0 || milestones > MAX_MILESTONES || bytes(metadataCid).length == 0
                || bytes(metadataCid).length > MAX_CID_LENGTH
        ) revert InvalidParameters();

        id = _campaigns.length;
        _campaigns.push(
            Campaign({
                creator: msg.sender,
                beneficiary: beneficiary,
                goal: goal,
                deadline: block.timestamp + duration,
                raised: 0,
                withdrawn: 0,
                milestones: milestones,
                tranchesApproved: 0,
                tranchesWithdrawn: 0,
                status: Status.Active,
                metadataCid: metadataCid
            })
        );
        emit CampaignCreated(id, msg.sender, beneficiary, goal, block.timestamp + duration, milestones, metadataCid);
    }

    /// @notice Contribue en ETH à la campagne `id` et reçoit des CFD (verrouillés) en retour.
    function contribute(uint256 id) external payable nonReentrant whenNotPaused {
        Campaign storage c = _get(id);
        if (c.status != Status.Active || block.timestamp >= c.deadline) revert CampaignNotActive();
        if (msg.value < MIN_CONTRIBUTION) revert ContributionTooLow();
        // Anti-« wash funding » : le porteur et le bénéficiaire ne peuvent pas gonfler leur propre campagne.
        if (msg.sender == c.creator || msg.sender == c.beneficiary) revert SelfFunding();

        uint256 minted = msg.value * TOKENS_PER_ETH;

        // Effects
        c.raised += msg.value;
        if (contributionOf[id][msg.sender] == 0) _contributors[id].push(msg.sender);
        contributionOf[id][msg.sender] += msg.value;
        lockedTokensOf[id][msg.sender] += minted;

        // Interaction (contrat de confiance, immuable)
        token.mintLocked(msg.sender, minted);

        emit Contributed(id, msg.sender, msg.value, minted);
    }

    /// @notice Le créateur peut annuler une campagne qui n'a reçu aucune contribution.
    function cancelEmptyCampaign(uint256 id) external {
        Campaign storage c = _get(id);
        if (msg.sender != c.creator) revert NotCreator();
        if (c.status != Status.Active) revert InvalidStatus(c.status);
        if (c.raised != 0) revert CampaignHasFunds();
        c.status = Status.Canceled;
        emit StatusChanged(id, Status.Canceled);
    }

    // =====================================================================
    //  Remboursement
    // =====================================================================

    /**
     * @notice Rembourse le contributeur si la campagne est Échouée ou Annulée (gelée).
     *         Si des tranches ont déjà été versées avant le gel, le remboursement est proportionnel
     *         à ce qui reste dans la campagne. Les CFD correspondants sont détruits.
     */
    function refund(uint256 id) external nonReentrant whenNotPaused {
        _refund(id, msg.sender);
    }

    /// @notice AUTOMATISATION : n'importe qui (typiquement le robot) peut déclencher le remboursement de `account`.
    ///         L'argent va TOUJOURS à `account`, jamais à l'appelant : aucun risque de détournement.
    function refundFor(uint256 id, address account) external nonReentrant whenNotPaused {
        _refund(id, account);
    }

    function _refund(uint256 id, address account) internal {
        Campaign storage c = _get(id);
        _sync(id, c);
        if (c.status != Status.Failed && c.status != Status.Canceled) revert NotRefundable();

        // ---- Checks
        uint256 contributed = contributionOf[id][account];
        if (contributed == 0) revert NothingToRefund();

        uint256 remaining = c.raised - c.withdrawn;
        uint256 amount = (contributed * remaining) / c.raised;
        uint256 tokens = lockedTokensOf[id][account];

        // ---- Effects (AVANT toute interaction externe)
        contributionOf[id][account] = 0;
        lockedTokensOf[id][account] = 0;

        // ---- Interactions
        if (tokens > 0) token.burnLocked(account, tokens);
        (bool ok,) = account.call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit Refunded(id, account, amount, tokens);
    }

    // =====================================================================
    //  Gouvernance : déblocage par tranches et gel
    // =====================================================================

    /**
     * @notice Valide la prochaine tranche (appelable uniquement par la DAO).
     *         Si la campagne est encore en cours mais l'objectif atteint, c'est un « déblocage
     *         anticipé » : la campagne passe à Réussie avant l'échéance.
     */
    function approveTranche(uint256 id) external onlyRole(GOVERNANCE_ROLE) {
        Campaign storage c = _get(id);
        _sync(id, c);
        if (c.status == Status.Active) {
            if (c.raised < c.goal) revert GoalNotReached();
            c.status = Status.Successful;
            emit StatusChanged(id, Status.Successful);
        } else if (c.status != Status.Successful) {
            revert InvalidStatus(c.status);
        }
        if (c.tranchesApproved >= c.milestones) revert NoTrancheAvailable();
        c.tranchesApproved += 1;
        emit TrancheApproved(id, c.tranchesApproved - 1);
    }

    /// @notice Gèle une campagne litigieuse (DAO uniquement) : elle devient Annulée et les fonds restants sont remboursables.
    function freezeCampaign(uint256 id) external onlyRole(GOVERNANCE_ROLE) {
        Campaign storage c = _get(id);
        _sync(id, c);
        if (c.status != Status.Active && c.status != Status.Successful) revert InvalidStatus(c.status);
        if (c.tranchesWithdrawn >= c.milestones) revert NoTrancheAvailable(); // plus rien à protéger
        c.status = Status.Canceled;
        emit CampaignFrozen(id);
        emit StatusChanged(id, Status.Canceled);
    }

    // =====================================================================
    //  Retraits
    // =====================================================================

    /// @notice Le bénéficiaire retire la prochaine tranche VALIDÉE par la DAO (moins 2 % de frais).
    function withdrawFunds(uint256 id) external nonReentrant whenNotPaused {
        if (msg.sender != _get(id).beneficiary) revert NotBeneficiary();
        _payout(id);
    }

    /// @notice AUTOMATISATION : n'importe qui (le robot) peut déclencher le versement d'une tranche DÉJÀ validée par la DAO.
    ///         L'argent est TOUJOURS envoyé au bénéficiaire enregistré, jamais à l'appelant.
    function payout(uint256 id) external nonReentrant whenNotPaused {
        _payout(id);
    }

    function _payout(uint256 id) internal {
        Campaign storage c = _get(id);
        _sync(id, c);
        if (c.status != Status.Successful) revert InvalidStatus(c.status);
        if (c.tranchesWithdrawn >= c.tranchesApproved) revert NoTrancheAvailable();

        // ---- Checks / calculs
        uint8 index = c.tranchesWithdrawn;
        uint256 gross = _trancheAmount(c, index);
        uint256 fee = (gross * FEE_BPS) / BPS;
        uint256 net = gross - fee;

        // ---- Effects
        c.tranchesWithdrawn = index + 1;
        c.withdrawn += gross;
        accruedFees += fee;

        // ---- Interactions
        (bool ok,) = c.beneficiary.call{value: net}("");
        if (!ok) revert TransferFailed();

        emit FundsWithdrawn(id, c.beneficiary, net, fee, index);
    }

    /// @notice Les contributeurs récupèrent leurs CFD (transférables) une fois TOUTES les tranches versées.
    function claimTokens(uint256 id) external nonReentrant whenNotPaused {
        _claim(id, msg.sender);
    }

    /// @notice AUTOMATISATION : n'importe qui (le robot) peut débloquer les CFD de `account` une fois la campagne livrée.
    ///         Les jetons restent à `account` : l'appelant n'y gagne rien.
    function claimTokensFor(uint256 id, address account) external nonReentrant whenNotPaused {
        _claim(id, account);
    }

    function _claim(uint256 id, address account) internal {
        Campaign storage c = _get(id);
        if (c.status != Status.Successful || c.tranchesWithdrawn != c.milestones) revert NotYetDelivered();
        uint256 amount = lockedTokensOf[id][account];
        if (amount == 0) revert NothingToClaim();
        lockedTokensOf[id][account] = 0;
        token.unlock(account, amount);
        emit TokensClaimed(id, account, amount);
    }

    /// @notice Envoie les frais accumulés vers la trésorerie multisig (appelable par tous).
    function sweepFees() external nonReentrant whenNotPaused {
        uint256 amount = accruedFees;
        if (amount == 0) revert NoFees();
        accruedFees = 0;
        (bool ok,) = treasury.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit FeesSwept(treasury, amount);
    }

    // =====================================================================
    //  Vues
    // =====================================================================

    function contributorCount(uint256 id) external view returns (uint256) {
        return _contributors[id].length;
    }

    function contributorAt(uint256 id, uint256 index) external view returns (address) {
        return _contributors[id][index];
    }

    function campaignCount() external view returns (uint256) {
        return _campaigns.length;
    }

    function getCampaign(uint256 id) external view returns (Campaign memory) {
        return _get(id);
    }

    function beneficiaryOf(uint256 id) external view returns (address) {
        return _get(id).beneficiary;
    }

    /// @notice Statut tenant compte de l'échéance (sans nécessiter de transaction).
    function effectiveStatus(uint256 id) public view returns (Status) {
        Campaign storage c = _get(id);
        if (c.status == Status.Active && block.timestamp >= c.deadline) {
            return c.raised >= c.goal ? Status.Successful : Status.Failed;
        }
        return c.status;
    }

    /// @notice Montant brut de la tranche `index` (la dernière absorbe l'arrondi).
    function trancheAmount(uint256 id, uint8 index) external view returns (uint256) {
        Campaign storage c = _get(id);
        if (index >= c.milestones) revert InvalidParameters();
        return _trancheAmount(c, index);
    }

    // =====================================================================
    //  Internes
    // =====================================================================

    function _get(uint256 id) internal view returns (Campaign storage) {
        if (id >= _campaigns.length) revert CampaignNotFound(id);
        return _campaigns[id];
    }

    /// @dev Met à jour paresseusement le statut après l'échéance.
    function _sync(uint256 id, Campaign storage c) internal {
        if (c.status == Status.Active && block.timestamp >= c.deadline) {
            c.status = c.raised >= c.goal ? Status.Successful : Status.Failed;
            emit StatusChanged(id, c.status);
        }
    }

    function _trancheAmount(Campaign storage c, uint8 index) internal view returns (uint256) {
        uint256 base = c.raised / c.milestones;
        if (index == c.milestones - 1) return c.raised - base * (c.milestones - 1);
        return base;
    }
}
