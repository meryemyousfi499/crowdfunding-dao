// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title CFDToken
 * @notice Jeton de gouvernance « CFD » (ERC-20) de la plateforme de crowdfunding.
 *
 * Choix de conception :
 *  - ERC20Votes : l'historique des soldes est enregistré par « checkpoints », ce qui permet
 *    d'interroger le pouvoir de vote à un bloc PASSÉ (getPastVotes). C'est la base de la
 *    défense anti prise de contrôle éclair (flash-loan / achat de dernière minute).
 *  - AccessControl : seul le rôle MINTER_ROLE (le contrat CrowdfundingCore) peut frapper,
 *    détruire ou verrouiller des jetons. Aucun compte humain n'a ce pouvoir.
 *  - Verrouillage : les jetons reçus en contrepartie d'une contribution sont NON TRANSFÉRABLES
 *    (mais comptent pour le vote) tant que la campagne n'est pas totalement livrée. S'ils
 *    sont verrouillés on ne peut ni les revendre, ni les prêter : un contributeur ne peut donc
 *    pas « encaisser » un jeton lié à une campagne qui peut encore échouer.
 *  - Auto-délégation : chaque détenteur est automatiquement délégué à lui-même, sinon ses
 *    jetons n'auraient aucun pouvoir de vote (comportement par défaut d'ERC20Votes).
 */
contract CFDToken is ERC20, ERC20Permit, ERC20Votes, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice Jetons verrouillés (non transférables) par adresse.
    mapping(address => uint256) public lockedBalanceOf;

    error ZeroAddress();
    error InsufficientUnlockedBalance(uint256 unlocked, uint256 needed);
    error UnlockExceedsLocked(uint256 locked, uint256 requested);

    event TokensLocked(address indexed account, uint256 amount);
    event TokensUnlocked(address indexed account, uint256 amount);

    constructor(address admin) ERC20("CrowdFund DAO", "CFD") ERC20Permit("CrowdFund DAO") {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ---------------------------------------------------------------------
    //  Fonctions réservées au Core (MINTER_ROLE)
    // ---------------------------------------------------------------------

    /// @notice Frappe `amount` jetons verrouillés pour `to` (contribution).
    function mintLocked(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        lockedBalanceOf[to] += amount;
        _mint(to, amount);
        emit TokensLocked(to, amount);
    }

    /// @notice Déverrouille `amount` jetons de `account` (campagne livrée).
    function unlock(address account, uint256 amount) external onlyRole(MINTER_ROLE) {
        _unlock(account, amount);
    }

    /// @notice Déverrouille puis détruit `amount` jetons de `account` (remboursement).
    function burnLocked(address account, uint256 amount) external onlyRole(MINTER_ROLE) {
        _unlock(account, amount);
        _burn(account, amount);
    }

    // ---------------------------------------------------------------------
    //  Internes
    // ---------------------------------------------------------------------

    function _unlock(address account, uint256 amount) internal {
        uint256 locked = lockedBalanceOf[account];
        if (amount > locked) revert UnlockExceedsLocked(locked, amount);
        lockedBalanceOf[account] = locked - amount;
        emit TokensUnlocked(account, amount);
    }

    /**
     * @dev Point central d'OpenZeppelin v5 pour mint / burn / transfer.
     *  1. Pour un transfert normal, on interdit de dépenser des jetons verrouillés.
     *  2. Auto-délégation du destinataire pour que ses jetons comptent dans le vote.
     */
    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Votes) {
        if (from != address(0) && to != address(0)) {
            uint256 unlocked = balanceOf(from) - lockedBalanceOf[from];
            if (value > unlocked) revert InsufficientUnlockedBalance(unlocked, value);
        }
        if (to != address(0) && delegates(to) == address(0)) {
            _delegate(to, to);
        }
        super._update(from, to, value);
    }

    function nonces(address owner) public view override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }
}
