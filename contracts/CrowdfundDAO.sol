// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
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
 *  2. VOTE QUADRATIQUE : le poids = racine carrée du solde (en CFD entiers) au snapshot.
 *     Obtenir 2x plus de voix coûte 4x plus de jetons : on réduit l'influence des baleines.
 *     Limite connue : le vote quadratique est sensible aux attaques Sybil (diviser ses fonds
 *     sur plusieurs adresses) ; contrepartie : contribution minimale, jetons verrouillés,
 *     quorum en NOMBRE de votants et détection hors-chaîne (script Python).
 *  3. TIMELOCK : une proposition adoptée doit être « queued » puis attend `timelockDelay`
 *     avant exécution (fenêtre pour réagir / alerter) ; elle expire après `GRACE_PERIOD`.
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
        Expired
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
        uint256 forVotes; // poids quadratique
        uint256 againstVotes;
        uint256 voters; // nombre de votants distincts
        string description;
    }

    uint256 public constant GRACE_PERIOD = 7 days;

    CFDToken public immutable token;
    ICrowdfundingCore public immutable core;
    uint256 public immutable votingPeriod;
    uint256 public immutable timelockDelay;
    uint256 public immutable proposalThreshold; // en CFD (18 décimales)
    uint256 public immutable quorumVoters; // nombre minimal de votants distincts

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

    constructor(
        CFDToken token_,
        ICrowdfundingCore core_,
        uint256 votingPeriod_,
        uint256 timelockDelay_,
        uint256 proposalThreshold_,
        uint256 quorumVoters_
    ) {
        require(address(token_) != address(0) && address(core_) != address(0), "zero address");
        require(votingPeriod_ > 0 && quorumVoters_ > 0, "bad params");
        token = token_;
        core = core_;
        votingPeriod = votingPeriod_;
        timelockDelay = timelockDelay_;
        proposalThreshold = proposalThreshold_;
        quorumVoters = quorumVoters_;
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

        uint256 snapshot = block.number - 1;
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
                forVotes: 0,
                againstVotes: 0,
                voters: 0,
                description: description
            })
        );
        emit ProposalCreated(id, msg.sender, kind, campaignId, snapshot, end, description);
    }

    // =====================================================================
    //  Vote quadratique pondéré par snapshot
    // =====================================================================

    function castVote(uint256 id, bool support) external {
        Proposal storage p = _get(id);
        if (block.timestamp >= p.voteEnd || p.queued || p.executed) revert NotActive();
        if (hasVoted[id][msg.sender]) revert AlreadyVoted();

        uint256 balance = token.getPastVotes(msg.sender, p.snapshotBlock);
        uint256 weight = Math.sqrt(balance / 1e18); // CFD entiers -> poids quadratique
        if (weight == 0) revert NoVotingPower();

        hasVoted[id][msg.sender] = true;
        p.voters += 1;
        if (support) p.forVotes += weight;
        else p.againstVotes += weight;

        emit VoteCast(id, msg.sender, support, weight, balance);
    }

    /// @notice Poids de vote quadratique d'un compte pour la proposition `id` (lecture front-end).
    function votingWeight(uint256 id, address account) external view returns (uint256 weight, uint256 rawBalance) {
        Proposal storage p = _get(id);
        rawBalance = token.getPastVotes(account, p.snapshotBlock);
        weight = Math.sqrt(rawBalance / 1e18);
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
        if (p.queued) {
            if (block.timestamp > p.eta + GRACE_PERIOD) return ProposalState.Expired;
            return ProposalState.Queued;
        }
        if (block.timestamp < p.voteEnd) return ProposalState.Active;
        bool quorumReached = p.voters >= quorumVoters;
        if (!quorumReached || p.forVotes <= p.againstVotes) return ProposalState.Defeated;
        return ProposalState.Succeeded;
    }

    function _get(uint256 id) internal view returns (Proposal storage) {
        if (id >= _proposals.length) revert ProposalNotFound(id);
        return _proposals[id];
    }
}
