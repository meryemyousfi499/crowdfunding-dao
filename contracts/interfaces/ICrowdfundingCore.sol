// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Interface minimale du Core utilisée par la DAO.
interface ICrowdfundingCore {
    enum Status {
        Active, // En cours
        Successful, // Réussie
        Failed, // Échouée
        Canceled // Annulée / gelée
    }

    function campaignCount() external view returns (uint256);

    function beneficiaryOf(uint256 campaignId) external view returns (address);

    function effectiveStatus(uint256 campaignId) external view returns (Status);

    function approveTranche(uint256 campaignId) external;

    function freezeCampaign(uint256 campaignId) external;
}
