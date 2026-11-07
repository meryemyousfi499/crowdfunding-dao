// Déploie M1 (CFDToken), M2 (CrowdfundingCore + MultiSigTreasury) et M3 (CrowdfundDAO),
// câble les rôles, puis exporte adresses + ABI vers frontend/contracts.json (lu par la dApp ET le script Python).
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const { ethers, network, artifacts } = hre;
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const isLocal = ["hardhat", "localhost"].includes(network.name);

  // Paramètres de gouvernance : courts en local (démo), réalistes sur testnet.
  const votingPeriod = Number(process.env.VOTING_PERIOD || (isLocal ? 300 : 3 * 24 * 3600));
  const timelockDelay = Number(process.env.TIMELOCK_DELAY || (isLocal ? 60 : 24 * 3600));
  const threshold = ethers.parseEther(process.env.PROPOSAL_THRESHOLD_CFD || (isLocal ? "10" : "100"));
  const quorumVoters = Number(process.env.QUORUM_VOTERS || (isLocal ? 2 : 5));

  // Propriétaires du multisig : en local 3 comptes de test ; sinon MULTISIG_OWNERS="0x..,0x..,0x.." (2 sur 3).
  const owners = process.env.MULTISIG_OWNERS
    ? process.env.MULTISIG_OWNERS.split(",").map((s) => s.trim())
    : isLocal ? [signers[17].address, signers[18].address, signers[19].address] : [deployer.address];
  const required = Number(process.env.MULTISIG_REQUIRED || (owners.length >= 3 ? 2 : 1));
  // Seuil du multisig : au-dessus (ou pour un appel de contrat) -> `required` signatures obligatoires.
  const smallLimit = ethers.parseEther(process.env.MULTISIG_SMALL_LIMIT_ETH || "0.1");

  console.log(`Réseau: ${network.name} | déployeur: ${deployer.address}`);

  // REPRISE après un déploiement interrompu (ex. manque d'ETH) : $env:RESUME_NONCE=0
  // = numéro de transaction du PREMIER contrat déjà déployé (0 pour un compte neuf). On réutilise alors
  // trésorerie / jeton / Core à leurs adresses déterministes au lieu de payer à nouveau.
  let treasury, token, core;
  const resume = process.env.RESUME_NONCE !== undefined && process.env.RESUME_NONCE !== "";
  if (resume) {
    const n0 = Number(process.env.RESUME_NONCE);
    const at = async (name, nonce) => {
      const addr = ethers.getCreateAddress({ from: deployer.address, nonce });
      if ((await ethers.provider.getCode(addr)) === "0x") throw new Error(`Aucun contrat ${name} à ${addr} (nonce ${nonce}) : RESUME_NONCE incorrect.`);
      console.log(`Reprise : ${name} déjà déployé à ${addr}`);
      return ethers.getContractAt(name, addr);
    };
    treasury = await at("MultiSigTreasury", n0);
    token = await at("CFDToken", n0 + 1);
    core = await at("CrowdfundingCore", n0 + 2);
  } else {
    treasury = await (await ethers.getContractFactory("MultiSigTreasury")).deploy(owners, required, smallLimit);
    await treasury.waitForDeployment();
    token = await (await ethers.getContractFactory("CFDToken")).deploy(deployer.address);
    await token.waitForDeployment();
    core = await (await ethers.getContractFactory("CrowdfundingCore")).deploy(
      await token.getAddress(), await treasury.getAddress(), deployer.address);
    await core.waitForDeployment();
  }
  const dao = await (await ethers.getContractFactory("CrowdfundDAO")).deploy(
    await token.getAddress(), await core.getAddress(), votingPeriod, timelockDelay, threshold, quorumVoters);
  await dao.waitForDeployment();

  // Câblage des rôles (principe du moindre privilège)
  await (await token.grantRole(await token.MINTER_ROLE(), await core.getAddress())).wait();
  await (await core.grantRole(await core.GOVERNANCE_ROLE(), await dao.getAddress())).wait();

  const net = await ethers.provider.getNetwork();
  const out = {
    network: network.name,
    chainId: Number(net.chainId),
    // URL publique pour la dApp (ne JAMAIS y mettre la clé Infura/Alchemy privée du .env)
    rpcUrl: isLocal ? "http://127.0.0.1:8545" : (process.env.PUBLIC_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com"),
    deployedAtBlock: await ethers.provider.getBlockNumber(),
    params: { votingPeriod, timelockDelay, proposalThresholdCFD: ethers.formatEther(threshold), quorumVoters, multisigRequired: required, multisigSmallLimitETH: ethers.formatEther(smallLimit) },
    addresses: {
      token: await token.getAddress(), core: await core.getAddress(),
      dao: await dao.getAddress(), treasury: await treasury.getAddress(),
    },
    abis: {
      token: (await artifacts.readArtifact("CFDToken")).abi,
      core: (await artifacts.readArtifact("CrowdfundingCore")).abi,
      dao: (await artifacts.readArtifact("CrowdfundDAO")).abi,
      treasury: (await artifacts.readArtifact("MultiSigTreasury")).abi,
    },
  };
  fs.writeFileSync(path.join(__dirname, "../frontend/contracts.json"), JSON.stringify(out, null, 2));
  console.log("Adresses:", out.addresses);
  console.log("Exporté -> frontend/contracts.json");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });