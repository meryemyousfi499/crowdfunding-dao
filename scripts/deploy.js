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

  // Paramètres de gouvernance : IDENTIQUES sur tous les réseaux (démo) : vote 5 min, timelock 2 min, seuil 10 CFD,
  // plancher de quorum 100 CFD, snapshot 2 blocs. Valeurs « production » recommandées : voir docs/ARCHITECTURE.md §7.
  const votingPeriod = Number(process.env.VOTING_PERIOD || 300);
  const timelockDelay = Number(process.env.TIMELOCK_DELAY || 120);
  const threshold = ethers.parseEther(process.env.PROPOSAL_THRESHOLD_CFD || "10");
  // Quorum sur les votes POUR, en points de base de l'offre au snapshot (1000 = 10 %).
  const quorumBps = Number(process.env.QUORUM_BPS || 1000);
  // Plancher absolu du quorum (CFD) : évite qu'un attaquant atteigne 10 % quand l'offre est encore minuscule.
  const minQuorum = ethers.parseEther(process.env.MIN_QUORUM_CFD || "100");
  // Maturité du snapshot (blocs) : 2 par défaut ; 7200 blocs ≈ 24 h sur Ethereum pour un usage réel.
  const snapshotLookback = Number(process.env.SNAPSHOT_LOOKBACK || 2);

  // Propriétaires du multisig : en local 3 comptes de test ; sinon MULTISIG_OWNERS="0x..,0x..,0x.." (2 sur 3).
  const owners = process.env.MULTISIG_OWNERS
    ? process.env.MULTISIG_OWNERS.split(",").map((s) => s.trim())
    : isLocal ? [signers[17].address, signers[18].address, signers[19].address] : [deployer.address];
  const required = Number(process.env.MULTISIG_REQUIRED || (owners.length >= 3 ? 2 : 1));
  // Garde-fou : hors local, le multisig doit être un vrai 2-sur-3 (sinon le veto et l'administration dépendent d'une seule personne).
  if (!isLocal && !process.env.ALLOW_WEAK_MULTISIG && (new Set(owners.map((o) => o.toLowerCase())).size < 3 || required < 2))
    throw new Error("Multisig faible : fournissez MULTISIG_OWNERS=\"0x..,0x..,0x..\" (3 adresses distinctes, 2 signatures) ou ALLOW_WEAK_MULTISIG=1 pour une démo.");
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
    await token.getAddress(), await core.getAddress(), votingPeriod, timelockDelay, threshold, quorumBps, minQuorum, snapshotLookback, await treasury.getAddress()); // guardian = multisig (veto)
  await dao.waitForDeployment();

  // Câblage des rôles (principe du moindre privilège)
  await (await token.grantRole(await token.MINTER_ROLE(), await core.getAddress())).wait();
  await (await core.grantRole(await core.GOVERNANCE_ROLE(), await dao.getAddress())).wait();

  // Droits d'administration : transférés au multisig puis retirés au déployeur (sinon un seul compte pourrait
  // s'accorder MINTER/GOVERNANCE et contourner la DAO). Le PAUSER_ROLE suit le même chemin (KEEP_PAUSER=1 pour le garder au déployeur : réaction plus rapide, mais un seul compte peut alors suspendre la plateforme).
  // (avant le transfert d'admin : accorder un rôle exige encore DEFAULT_ADMIN_ROLE)
  if (process.env.KEEP_PAUSER !== "1") {
    const PAUSER = await core.PAUSER_ROLE();
    await (await core.grantRole(PAUSER, await treasury.getAddress())).wait();
    await (await core.renounceRole(PAUSER, deployer.address)).wait();
    console.log("PAUSER_ROLE transféré au multisig (pause = 2 signatures sur 3).");
  }
  if (process.env.KEEP_ADMIN !== "1") {
    const ADMIN = await token.DEFAULT_ADMIN_ROLE();
    const ms = await treasury.getAddress();
    for (const c of [token, core]) {
      await (await c.grantRole(ADMIN, ms)).wait();
      await (await c.renounceRole(ADMIN, deployer.address)).wait();
    }
    console.log("DEFAULT_ADMIN_ROLE transféré au multisig et retiré au déployeur.");
  }

  const net = await ethers.provider.getNetwork();
  const out = {
    network: network.name,
    chainId: Number(net.chainId),
    // URL publique pour la dApp (ne JAMAIS y mettre la clé Infura/Alchemy privée du .env)
    rpcUrl: isLocal ? "http://127.0.0.1:8545" : (process.env.PUBLIC_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com"),
    deployedAtBlock: await ethers.provider.getBlockNumber(),
    params: { votingPeriod, timelockDelay, proposalThresholdCFD: ethers.formatEther(threshold), quorumBps, quorumPercent: quorumBps / 100, minQuorumCFD: ethers.formatEther(minQuorum), snapshotLookback, multisigRequired: required, multisigSmallLimitETH: ethers.formatEther(smallLimit) },
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

  // Copie datée par réseau (versionnée dans Git) : frontend/contracts.json est écrasé par chaque déploiement local,
  // alors que deployments/sepolia.json reste la trace du déploiement public.
  const dep = path.join(__dirname, "../deployments");
  fs.mkdirSync(dep, { recursive: true });
  fs.writeFileSync(path.join(dep, `${network.name}.json`), JSON.stringify(out, null, 2));
  if (!isLocal) {
    const scan = out.chainId === 11155111 ? "https://sepolia.etherscan.io" : "";
    const link = (a) => (scan ? `[${a}](${scan}/address/${a})` : a);
    fs.writeFileSync(path.join(__dirname, "../docs/DEPLOIEMENT_SEPOLIA.md"), `# Déploiement ${network.name} (chainId ${out.chainId})
Déployé au bloc ${out.deployedAtBlock} par \`${deployer.address}\`.

| Contrat | Adresse |
|---|---|
| CFDToken (M1) | ${link(out.addresses.token)} |
| CrowdfundingCore (M2) | ${link(out.addresses.core)} |
| CrowdfundDAO (M3) | ${link(out.addresses.dao)} |
| MultiSigTreasury | ${link(out.addresses.treasury)} |

Paramètres : ${JSON.stringify(out.params)}

Pour pointer la dApp sur ce déploiement : \`npm run use:sepolia\` (copie deployments/sepolia.json vers frontend/contracts.json).
`);
    console.log("Écrit -> deployments/" + network.name + ".json et docs/DEPLOIEMENT_SEPOLIA.md (à versionner dans Git)");
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });