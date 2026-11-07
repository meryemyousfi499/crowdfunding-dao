// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CrowdfundingCore} from "../CrowdfundingCore.sol";

/// @notice CONTRAT MALVEILLANT DE TEST UNIQUEMENT : tente de ré-entrer dans refund().
contract ReentrancyAttacker {
    CrowdfundingCore public immutable core;
    uint256 public campaignId;
    uint256 public reentries;
    bool public lastReentryReverted;

    constructor(CrowdfundingCore core_) {
        core = core_;
    }

    function fund(uint256 id) external payable {
        campaignId = id;
        core.contribute{value: msg.value}(id);
    }

    function attack() external {
        core.refund(campaignId);
    }

    receive() external payable {
        if (reentries < 3) {
            reentries++;
            try core.refund(campaignId) {
                lastReentryReverted = false;
            } catch {
                lastReentryReverted = true;
            }
        }
    }
}
