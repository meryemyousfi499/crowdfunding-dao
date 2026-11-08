// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CFDToken} from "./CFDToken.sol";
import {ICrowdfundingCore} from "./interfaces/ICrowdfundingCore.sol";

/**
 * @title CrowdfundDAO
 * @notice Gouvernance de la plateforme. La DAO valide les tranches de déblocage (milestones)
 *         et peut geler une campagne suspecte.
 *
 * Mécanismes anti-manipulation :
 *  1. SNAPSHOT : le pouvoir de vote est lu au bloc (création de la proposition - 1) via
 *     token.getPastVotes. Acheter / emprunter des CFD (flash loan) APRÈS la création d'une
 *     proposition ne donne aucun poids. Les CFD sont de plus verrouillés (non transférables)
 *     tant qu'une campagne n'est pas livrée.
 *  2. VOTE LINÉAIRE : poids = solde exact de CFD (18 décimales, sans arrondi) au snapshot. Les CFD sont verrouillés et
 *     proportionnels aux ETH engagés : fractionner ses fonds sur 50 adresses donne EXACTEMENT le même
 *     pouvoir total que sur une seule (aucun avantage Sybil). L'attaquant doit immobiliser du capital réel.
 *  2bis. QUORUM SUR LES VOTES « POUR » : les votes pour doivent représenter au moins `quorumBps`
 *     (ex. 10 %) de l'offre totale de CFD au snapshot ET au moins `minQuorum` CFD en valeur absolue
 *     (plancher : quand l'offre est encore petite, 10 % ne coûterait presque rien à un attaquant). Un attaquant minoritaire seul ne peut pas
 *     faire passer une proposition : il doit convaincre de vrais contributeurs.
 *  2ter. MATURITÉ DU SNAPSHOT : le snapshot est pris `snapshotLookback` blocs AVANT la création de la
 *     proposition. Il faut donc détenir ses CFD depuis un certain temps pour proposer ou voter
 *     (acheter puis proposer aussitôt ne donne aucun poids).
 *  3. TIMELOCK : une proposition adoptée doit être « queued » puis attend `timelockDelay`
 *     avant exécution (fenêtre pour réagir / alerter) ; elle expire après `GRACE_PERIOD`.
 *  3bis. VETO DU MULTISIG (`guardian`) : pendant le timelock, le multisig 2-sur-3 peut ANNULER une
 *     proposition adoptée mais malveillante. Il ne peut qu'annuler : jamais approuver ni exécuter.
 *  4. SEUIL DE PROPOSITION : il faut détenir `proposalThreshold` CFD au snapshot pour proposer.
 *  5. EFFETS AVANT INTERACTIONS : l'état est mis à jour avant l'appel au Core.
 */
contract CrowdfundDAO is ReentrancyGuard {
    enum ProposalType {
        ApproveTranche, // débloquer la prochaine tranche d'une campagne
        FreezeCampaign // geler une campagne frauduleuse
    }

    enum ProposalState {
        Pending, // (réservé) pas de délai de vote : le snapshot est pris à la création
        Active,
        Defeated,
        Succeeded,
        Queued,
        Executed,
        Expired,
        Canceled // annulée par le veto du multisig pendant le timelock
    }

    struct Proposal {
        address proposer;
        ProposalType kind;
        uint256 campaignId;
        uint256 snapshotBlock;
        uint64 voteStart;
        uint64 voteEnd;
        uint64 eta; // date d'exécution possible (timelock) ; 0 si non mis en file
        bool queued;
        bool executed;
        bool canceled;
        uint256 forVotes; // poids linéaire (solde de CFD, 18 décimales)
        uint256 againstVotes;
        uint256 voters; // nombre de votants distincts
        string description;
    }

    uint256 public constant GRACE_PERIOD = 7 days;
    uint256 public constant BPS = 10_000;

    CFDToken public immutable token;
    ICrowdfundingCore public immutable core;
    uint256 public immutable votingPeriod;
    uint256 public immutable timelockDelay;
    uint256 public immutable proposalThreshold; // en CFD (18 décimales)
    uint256 public immutable quorumBps; // quorum sur les votes POUR, en points de base de l'offre au snapshot (1000 = 10 %)
    uint256 public immutable minQuorum; // plancher absolu du quorum, en CFD (18 décimales)
    uint256 public immutable snapshotLookback; // nombre de blocs entre le snapshot et la création de la proposition (>= 1)
    address public immutable guardian; // multisig autorisé à opposer son veto pendant le timelock

    Proposal[] private _proposals;
    mapping(uint256 => mapping(address => bool)) public hasVoted;
    /// @dev Une seule proposition ouverte par (type, campagne) : anti-spam.
    mapping(bytes32 => bool) public openProposal;

    error BelowThreshold(uint256 power, uint256 required);
    error InvalidCampaign();
    error InvalidDescription();
    error AlreadyOpen();
    error ProposalNotFound(uint256 id);
    error NotActive();
    error AlreadyVoted();
    error NoVotingPower();
    error WrongState(ProposalState current);
    error TimelockNotElapsed(uint64 eta);
    error InvalidAction();
    error NotGuardian();

    event ProposalCreated(
        uint256 indexed id,
        address indexed proposer,
        ProposalType kind,
        uint256 indexed campaignId,
        uint256 snapshotBlock,
        uint64 voteEnd,
        string description
    );
    event VoteCast(uint256 indexed id, address indexed voter, bool support, uint256 weight, uint256 rawBalance);
    event ProposalQueued(uint256 indexed id, uint64 eta);
    event ProposalExecuted(uint256 indexed id);
    event ProposalCanceled(uint256 indexed id, address indexed guardian, string reason);

    constructor(
        CFDToken token_,
        ICrowdfundingCore core_,
        uint256 votingPeriod_,
        uint256 timelockDelay_,
        uint256 proposalThreshold_,
        uint256 quorumBps_,
        uint256 minQuorum_,
        uint256 snapshotLookback_,
        address guardian_
    ) {
        require(address(token_) != address(0) && address(core_) != address(0), "zero address");
        require(guardian_ != address(0), "zero address");
        require(votingPeriod_ > 0 && quorumBps_ > 0 && quorumBps_ <= BPS && snapshotLookback_ >= 1, "bad params");
        token = token_;
        core = core_;
        votingPeriod = votingPeriod_;
        timelockDelay = timelockDelay_;
        proposalThreshold = proposalThreshold_;
        quorumBps = quorumBps_;
        minQuorum = minQuorum_;
        snapshotLookback = snapshotLookback_;
        guardian = guardian_;
    }

    // =====================================================================
    //  Propositions
    // =====================================================================

    function propose(ProposalType kind, uint256 campaignId, string calldata description)
        external
        returns (uint256 id)
    {
        if (campaignId >= core.campaignCount()) revert InvalidCampaign();
        uint256 len = bytes(description).length;
        if (len == 0 || len > 500) revert InvalidDescription();

        uint256 snapshot = block.number > snapshotLookback ? block.number - snapshotLookback : 0;
        uint256 power = token.getPastVotes(msg.sender, snapshot);
        if (power < proposalThreshold) revert BelowThreshold(power, proposalThreshold);

        bytes32 key = keccak256(abi.encode(kind, campaignId));
        if (openProposal[key]) revert AlreadyOpen();
        openProposal[key] = true;

        id = _proposals.length;
        uint64 end = uint64(block.timestamp + votingPeriod);
        _proposals.push(
            Proposal({
                proposer: msg.sender,
                kind: kind,
                campaignId: campaignId,
                snapshotBlock: snapshot,
                voteStart: uint64(block.timestamp),
                voteEnd: end,
                eta: 0,
                queued: false,
                executed: false,
                canceled: false,
                forVotes: 0,
                againstVotes: 0,
                voters: 0,
                description: description
            })
        );
        emit ProposalCreated(id, msg.sender, kind, campaignId, snapshot, end, description);
    }

    // =====================================================================
    //  Vote linéaire pondéré par snapshot
    // =====================================================================

    function castVote(uint256 id, bool support) external {
        Proposal storage p = _get(id);
        if (block.timestamp >= p.voteEnd || p.queued || p.executed) revert NotActive();
        if (hasVoted[id][msg.sender]) revert AlreadyVoted();

        uint256 balance = token.getPastVotes(msg.sender, p.snapshotBlock);
        uint256 weight = balance; // vote linéaire exact : 1 CFD = 1 voix (aucun arrondi)
        if (weight == 0) revert NoVotingPower();

        hasVoted[id][msg.sender] = true;
        p.voters += 1;
        if (support) p.forVotes += weight;
        else p.againstVotes += weight;

        emit VoteCast(id, msg.sender, support, weight, balance);
    }

    /// @notice Poids de vote linéaire d'un compte pour la proposition `id` (lecture front-end).
    function votingWeight(uint256 id, address account) external view returns (uint256 weight, uint256 rawBalance) {
        Proposal storage p = _get(id);
        rawBalance = token.getPastVotes(account, p.snapshotBlock);
        weight = rawBalance;
    }

    // =====================================================================
    //  Timelock & exécution
    // =====================================================================

    /// @notice Met une proposition adoptée en file d'attente (démarre le timelock).
    function queue(uint256 id) external {
        _queue(id);
    }

    function _queue(uint256 id) internal {
        ProposalState s = state(id);
        if (s != ProposalState.Succeeded) revert WrongState(s);
        Proposal storage p = _proposals[id];
        p.queued = true;
        p.eta = uint64(block.timestamp + timelockDelay);
        emit ProposalQueued(id, p.eta);
    }

    /// @notice VETO : le multisig (guardian) annule une proposition en file d'attente (timelock).
    ///         Il ne peut qu'annuler : aucune approbation ni exécution n'est possible par cette voie.
    function cancel(uint256 id, string calldata reason) external {
        if (msg.sender != guardian) revert NotGuardian();
        ProposalState s = state(id);
        if (s != ProposalState.Queued) revert WrongState(s);
        Proposal storage p = _proposals[id];
        p.canceled = true;
        openProposal[keccak256(abi.encode(p.kind, p.campaignId))] = false;
        emit ProposalCanceled(id, msg.sender, reason); // motif public : transparence du veto
    }

    /// @notice Exécute la proposition une fois le timelock écoulé (et avant expiration).
    function execute(uint256 id) external nonReentrant {
        _execute(id);
    }

    function _execute(uint256 id) internal {
        ProposalState s = state(id);
        if (s != ProposalState.Queued) revert WrongState(s);
        Proposal storage p = _proposals[id];
        if (block.timestamp < p.eta) revert TimelockNotElapsed(p.eta);

        // Effects
        p.executed = true;
        openProposal[keccak256(abi.encode(p.kind, p.campaignId))] = false;

        // Interactions
        if (p.kind == ProposalType.ApproveTranche) core.approveTranche(p.campaignId);
        else core.freezeCampaign(p.campaignId);

        emit ProposalExecuted(id);
    }

    // =====================================================================
    //  Exécution AUTOMATIQUE (keeper)
    //  Une blockchain ne peut pas se « réveiller » seule : une transaction doit toujours être
    //  envoyée par quelqu'un. L'exécution est donc SANS PERMISSION : n'importe quel robot
    //  (scripts/keeper.js, Chainlink Automation, Gelato...) appelle ces deux fonctions, compatibles
    //  avec l'interface « AutomationCompatible » de Chainlink. Aucun privilège n'est accordé au
    //  robot : il ne peut que faire avancer des propositions DÉJÀ adoptées par le vote.
    // =====================================================================

    /// @notice Vue pour les robots : y a-t-il une mise en file (action 0) ou une exécution (action 1) à faire ?
    function checkUpkeep(bytes calldata) external view returns (bool upkeepNeeded, bytes memory performData) {
        uint256 n = _proposals.length;
        for (uint256 i; i < n; ++i) {
            ProposalState s = state(i);
            if (s == ProposalState.Succeeded) return (true, abi.encode(i, uint8(0)));
            if (s == ProposalState.Queued && block.timestamp >= _proposals[i].eta) return (true, abi.encode(i, uint8(1)));
        }
        return (false, "");
    }

    /// @notice Effectue l'action trouvée par checkUpkeep (revalidée ici : on ne fait jamais confiance au robot).
    function performUpkeep(bytes calldata performData) external nonReentrant {
        (uint256 id, uint8 action) = abi.decode(performData, (uint256, uint8));
        if (action == 0) _queue(id);
        else if (action == 1) {
            ProposalState s = state(id);
            if (s != ProposalState.Queued) revert WrongState(s);
            if (block.timestamp < _proposals[id].eta) revert TimelockNotElapsed(_proposals[id].eta);
            _execute(id);
        } else revert InvalidAction();
    }

    /// @notice Libère le verrou « une proposition à la fois » pour une proposition rejetée ou expirée.
    function release(uint256 id) external {
        ProposalState s = state(id);
        if (s != ProposalState.Defeated && s != ProposalState.Expired) revert WrongState(s);
        Proposal storage p = _proposals[id];
        openProposal[keccak256(abi.encode(p.kind, p.campaignId))] = false;
    }

    // =====================================================================
    //  Vues
    // =====================================================================

    function proposalCount() external view returns (uint256) {
        return _proposals.length;
    }

    function getProposal(uint256 id) external view returns (Proposal memory) {
        return _get(id);
    }

    function state(uint256 id) public view returns (ProposalState) {
        Proposal storage p = _get(id);
        if (p.executed) return ProposalState.Executed;
        if (p.canceled) return ProposalState.Canceled;
        if (p.queued) {
            if (block.timestamp > p.eta + GRACE_PERIOD) return ProposalState.Expired;
            return ProposalState.Queued;
        }
        if (block.timestamp < p.voteEnd) return ProposalState.Active;
        // Quorum sur les votes POUR : forVotes >= quorumBps % de l'offre de CFD au snapshot ET >= minQuorum (plancher absolu).
        uint256 supply = token.getPastTotalSupply(p.snapshotBlock);
        bool quorumReached = p.forVotes * BPS >= supply * quorumBps && p.forVotes >= minQuorum;
        if (!quorumReached || p.forVotes <= p.againstVotes) return ProposalState.Defeated;
        return ProposalState.Succeeded;
    }

    function _get(uint256 id) internal view returns (Proposal storage) {
        if (id >= _proposals.length) revert ProposalNotFound(id);
        return _proposals[id];
    }
}
