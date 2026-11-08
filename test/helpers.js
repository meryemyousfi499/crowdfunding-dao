const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 24 * 3600;
const VOTING_PERIOD = 300; // 5 min (défaut de deploy.js)
const TIMELOCK = 120; // 2 min (défaut de deploy.js)
const THRESHOLD = ethers.parseEther("10"); // 10 CFD pour proposer
const MIN_QUORUM = 0n; // plancher absolu désactivé par défaut dans les tests (testé à part)
const LOOKBACK = 1; // snapshot = bloc précédent (testé à part avec une valeur plus grande)
const QUORUM_BPS = 1000; // quorum : 10 % de l'offre, sur les votes POUR

async function deployAll() {
  const [admin, creator, beneficiary, alice, bob, carol, dave, whale, o1, o2, o3] = await ethers.getSigners();

  const Multi = await ethers.getContractFactory("MultiSigTreasury");
  const treasury = await Multi.deploy([o1.address, o2.address, o3.address], 2, ethers.parseEther("0.1"));

  const Token = await ethers.getContractFactory("CFDToken");
  const token = await Token.deploy(admin.address);

  const Core = await ethers.getContractFactory("CrowdfundingCore");
  const core = await Core.deploy(await token.getAddress(), await treasury.getAddress(), admin.address);

  const DAO = await ethers.getContractFactory("CrowdfundDAO");
  const dao = await DAO.deploy(
    await token.getAddress(),
    await core.getAddress(),
    VOTING_PERIOD,
    TIMELOCK,
    THRESHOLD,
    QUORUM_BPS,
    MIN_QUORUM,
    LOOKBACK,
    await treasury.getAddress() // guardian : le multisig 2-sur-3 détient le veto
  );

  await token.grantRole(await token.MINTER_ROLE(), await core.getAddress());
  await core.grantRole(await core.GOVERNANCE_ROLE(), await dao.getAddress());

  return { admin, creator, beneficiary, alice, bob, carol, dave, whale, o1, o2, o3, treasury, token, core, dao };
}

async function createCampaign(core, creator, beneficiary, { goal = "10", duration = 7 * DAY, milestones = 2 } = {}) {
  await core.connect(creator).createCampaign(ethers.parseEther(goal), duration, beneficiary.address, "QmTestCid", milestones);
  return (await core.campaignCount()) - 1n;
}

module.exports = { deployAll, createCampaign, time, DAY, VOTING_PERIOD, TIMELOCK, THRESHOLD, QUORUM_BPS, MIN_QUORUM, LOOKBACK };