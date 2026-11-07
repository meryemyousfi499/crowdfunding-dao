// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title MultiSigTreasury
 * @notice Trésorerie multi-signatures (M sur N) qui reçoit les frais de plateforme.
 *         SEUIL : un simple envoi d'ETH <= `smallLimit` peut être exécuté avec 1 seule confirmation
 *         (frais courants). Au-delà du seuil, ou pour tout appel de contrat (calldata non vide,
 *         qui peut faire n'importe quoi), `required` confirmations (ex. 2 sur 3) sont OBLIGATOIRES.
 */
contract MultiSigTreasury is ReentrancyGuard {
    struct Tx {
        address to;
        uint256 value;
        bytes data;
        bool executed;
        uint256 confirmations;
    }

    address[] public owners;
    mapping(address => bool) public isOwner;
    uint256 public immutable required;
    /// @notice Montant (wei) jusqu'auquel un envoi simple n'exige qu'une confirmation.
    uint256 public immutable smallLimit;
    Tx[] private _txs;
    mapping(uint256 => mapping(address => bool)) public confirmed;

    event Deposit(address indexed from, uint256 amount);
    event Submitted(uint256 indexed txId, address indexed owner, address to, uint256 value);
    event Confirmed(uint256 indexed txId, address indexed owner);
    event Revoked(uint256 indexed txId, address indexed owner);
    event Executed(uint256 indexed txId);

    error NotOwner();
    error InvalidTx();
    error AlreadyConfirmed();
    error NotConfirmed();
    error AlreadyExecuted();
    error NotEnoughConfirmations();
    error CallFailed();

    modifier onlyOwner() {
        if (!isOwner[msg.sender]) revert NotOwner();
        _;
    }

    constructor(address[] memory owners_, uint256 required_, uint256 smallLimit_) {
        require(owners_.length > 0 && required_ > 0 && required_ <= owners_.length, "bad config");
        for (uint256 i; i < owners_.length; ++i) {
            address o = owners_[i];
            require(o != address(0) && !isOwner[o], "bad owner");
            isOwner[o] = true;
            owners.push(o);
        }
        required = required_;
        smallLimit = smallLimit_;
    }

    receive() external payable {
        emit Deposit(msg.sender, msg.value);
    }

    function submit(address to, uint256 value, bytes calldata data) external onlyOwner returns (uint256 txId) {
        txId = _txs.length;
        _txs.push(Tx({to: to, value: value, data: data, executed: false, confirmations: 0}));
        emit Submitted(txId, msg.sender, to, value);
        _confirm(txId);
    }

    function confirm(uint256 txId) external onlyOwner {
        _confirm(txId);
    }

    function revoke(uint256 txId) external onlyOwner {
        if (txId >= _txs.length) revert InvalidTx();
        Tx storage t = _txs[txId];
        if (t.executed) revert AlreadyExecuted();
        if (!confirmed[txId][msg.sender]) revert NotConfirmed();
        confirmed[txId][msg.sender] = false;
        t.confirmations -= 1;
        emit Revoked(txId, msg.sender);
    }

    function execute(uint256 txId) external onlyOwner nonReentrant {
        if (txId >= _txs.length) revert InvalidTx();
        Tx storage t = _txs[txId];
        if (t.executed) revert AlreadyExecuted();
        if (t.confirmations < _needed(t)) revert NotEnoughConfirmations();
        t.executed = true;
        (bool ok,) = t.to.call{value: t.value}(t.data);
        if (!ok) revert CallFailed();
        emit Executed(txId);
    }

    /// @notice Nombre de confirmations nécessaires pour la transaction `txId`.
    function neededConfirmations(uint256 txId) external view returns (uint256) {
        if (txId >= _txs.length) revert InvalidTx();
        return _needed(_txs[txId]);
    }

    function _needed(Tx storage t) internal view returns (uint256) {
        return (t.value > smallLimit || t.data.length > 0) ? required : 1;
    }

    function txCount() external view returns (uint256) {
        return _txs.length;
    }

    function getTx(uint256 txId) external view returns (Tx memory) {
        return _txs[txId];
    }

    function getOwners() external view returns (address[] memory) {
        return owners;
    }

    function _confirm(uint256 txId) internal {
        if (txId >= _txs.length) revert InvalidTx();
        Tx storage t = _txs[txId];
        if (t.executed) revert AlreadyExecuted();
        if (confirmed[txId][msg.sender]) revert AlreadyConfirmed();
        confirmed[txId][msg.sender] = true;
        t.confirmations += 1;
        emit Confirmed(txId, msg.sender);
    }
}
