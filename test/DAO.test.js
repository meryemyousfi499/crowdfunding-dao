const { expect } = require("chai");
const { ethers } = require("hardhat");
const { mine } = require("@nomicfoundation/hardhat-network-helpers");
const { deployAll, createCampaign, time, DAY, VOTING_PERIOD, TIMELOCK, THRESHOLD, QUORUM_BPS } = require("./helpers");

async function setup() {
  const ctx = await deployAll();
  const { core, creator, beneficiary, alice, bob, carol, dave } = ctx;
  const id = await createCampaign(core, creator, beneficiary, { goal: "5", milestones: 2 });
  await core.connect(alice).contribute(id, { value: ethers.parseEther("2") }); // 2000 CFD -> poids 44
  await core.connect(bob).contribute(id, { value: ethers.parseEther("1") }); //   1000 CFD -> poids 31
  await core.connect(carol).contribute(id, { value: ethers.parseEther("1") }); //  1000 CFD -> poids 31
  await core.connect(dave).contribute(id, { value: ethers.parseEther("1") }); //   1000 CFD -> poids 31
  return { ...ctx, id };
}

describe("CrowdfundDAO (M3 - Gouvernance)", () => {
  it("cycle complet : proposer -> voter -> queue -> timelock -> exécuter -> retirer par tranches", async () => {
    const { core, dao, id, alice, bob, carol, dave, beneficiary, treasury } = await setup();
    await dao.connect(alice).propose(0, id, "Valider la tranche 1");
    await dao.connect(alice).castVote(0, true);
    await dao.connect(bob).castVote(0, true);
    await dao.connect(carol).castVote(0, false);
    await time.increase(VOTING_PERIOD + 1);
    expect(await dao.state(0)).to.equal(3n); // Succeeded
    await dao.queue(0);

    // Timelock : exécution immédiate impossible
    await expect(dao.execute(0)).to.be.revertedWithCustomError(dao, "TimelockNotElapsed");
    await time.increase(TIMELOCK + 1);
    await dao.execute(0);
    expect(await dao.state(0)).to.equal(5n); // Executed

    // Tranche 1 = 2.5 ETH, frais 2 %
    expect(await core.effectiveStatus(id)).to.equal(1n); // Successful (déblocage anticipé, 5/5)
    await expect(core.connect(beneficiary).withdrawFunds(id)).to.changeEtherBalance(beneficiary, ethers.parseEther("2.45"));
    expect(await core.accruedFees()).to.equal(ethers.parseEther("0.05"));
    await expect(core.connect(beneficiary).withdrawFunds(id)).to.be.revertedWithCustomError(core, "NoTrancheAvailable");

    // Frais -> trésorerie multisig
    await expect(core.sweepFees()).to.changeEtherBalance(treasury, ethers.parseEther("0.05"));

    // Tranche 2
    await dao.connect(alice).propose(0, id, "Valider la tranche 2");
    await dao.connect(alice).castVote(1, true);
    await dao.connect(bob).castVote(1, true);
    await dao.connect(dave).castVote(1, true);
    await time.increase(VOTING_PERIOD + 1);
    await dao.queue(1);
    await time.increase(TIMELOCK + 1);
    await dao.execute(1);
    await core.connect(beneficiary).withdrawFunds(id);
    expect(await ethers.provider.getBalance(await core.getAddress())).to.equal(ethers.parseEther("0.05"));
  });

  it("les CFD sont débloqués une fois toutes les tranches versées", async () => {
    const { core, token, dao, id, alice, bob, dave, beneficiary } = await setup();
    await expect(core.connect(alice).claimTokens(id)).to.be.revertedWithCustomError(core, "NotYetDelivered");
    for (let n = 0; n < 2; n++) {
      await dao.connect(alice).propose(0, id, "tranche " + n);
      await dao.connect(alice).castVote(n, true);
      await dao.connect(bob).castVote(n, true);
      await dao.connect(dave).castVote(n, true);
      await time.increase(VOTING_PERIOD + 1);
      await dao.queue(n);
      await time.increase(TIMELOCK + 1);
      await dao.execute(n);
      await core.connect(beneficiary).withdrawFunds(id);
    }
    await core.connect(alice).claimTokens(id);
    expect(await token.lockedBalanceOf(alice.address)).to.equal(0n);
    await token.connect(alice).transfer(bob.address, ethers.parseEther("100"));
    expect(await token.balanceOf(bob.address)).to.equal(ethers.parseEther("1100"));
  });

  describe("vote linéaire (1 CFD = 1 voix)", () => {
    it("poids = solde de CFD au snapshot", async () => {
      const { dao, id, alice, bob } = await setup();
      await dao.connect(alice).propose(0, id, "x");
      await dao.connect(alice).castVote(0, true); // 2000 CFD
      await dao.connect(bob).castVote(0, false); //  1000 CFD
      const p = await dao.getProposal(0);
      expect(p.forVotes).to.equal(ethers.parseEther("2000"));
      expect(p.againstVotes).to.equal(ethers.parseEther("1000"));
    });

    it("aucun arrondi : un solde de 1,5 CFD compte pour 1,5 voix", async () => {
      const { core, dao, id, alice, whale } = await setup();
      await core.connect(whale).contribute(id, { value: ethers.parseEther("0.0015") }); // 1,5 CFD, AVANT la proposition
      await dao.connect(alice).propose(0, id, "x");
      const [w, raw] = await dao.votingWeight(0, whale.address);
      expect(w).to.equal(ethers.parseEther("1.5"));
      expect(raw).to.equal(w);
      await dao.connect(whale).castVote(0, true);
      expect((await dao.getProposal(0)).forVotes).to.equal(ethers.parseEther("1.5"));
    });

    it("anti-Sybil : 4 adresses à 1 ETH pèsent exactement comme 1 adresse à 4 ETH", async () => {
      const { core, dao, id, alice, bob, carol, dave, whale } = await deployAll().then(async (c) => ({
        ...c,
        id: await createCampaign(c.core, c.creator, c.beneficiary, { goal: "100" }),
      }));
      await core.connect(whale).contribute(id, { value: ethers.parseEther("4") }); // 1 adresse : 4000 CFD
      for (const u of [alice, bob, carol, dave]) await core.connect(u).contribute(id, { value: ethers.parseEther("1") }); // 4 adresses : 1000 CFD chacune
      await dao.connect(alice).propose(0, id, "x");
      await dao.connect(whale).castVote(0, false);
      for (const u of [alice, bob, carol, dave]) await dao.connect(u).castVote(0, true);
      const p = await dao.getProposal(0);
      expect(p.againstVotes).to.equal(ethers.parseEther("4000"));
      expect(p.forVotes).to.equal(ethers.parseEther("4000")); // le fractionnement ne donne AUCUN avantage
      await time.increase(VOTING_PERIOD + 1);
      expect(await dao.state(0)).to.equal(2n); // Defeated (pour == contre)
    });

    it("un compte sans jeton ne peut pas voter, et on ne vote qu'une fois", async () => {
      const { dao, id, alice, creator } = await setup();
      await dao.connect(alice).propose(0, id, "x");
      await expect(dao.connect(creator).castVote(0, true)).to.be.revertedWithCustomError(dao, "NoVotingPower");
      await dao.connect(alice).castVote(0, true);
      await expect(dao.connect(alice).castVote(0, true)).to.be.revertedWithCustomError(dao, "AlreadyVoted");
    });
  });

  describe("snapshot : anti flash-loan / achat de dernière minute", () => {
    it("des jetons obtenus APRÈS la création de la proposition n'ont aucun poids", async () => {
      const { core, dao, id, alice, whale } = await setup();
      await dao.connect(alice).propose(0, id, "x");
      // Un attaquant « achète » massivement après le snapshot
      await core.connect(whale).contribute(id, { value: ethers.parseEther("50") });
      await mine(2);
      await expect(dao.connect(whale).castVote(0, false)).to.be.revertedWithCustomError(dao, "NoVotingPower");
      const [w] = await dao.votingWeight(0, whale.address);
      expect(w).to.equal(0n);
    });

    it("il faut un solde suffisant AU snapshot pour proposer", async () => {
      const { core, dao, id, whale, creator } = await setup();
      await expect(dao.connect(creator).propose(0, id, "x")).to.be.revertedWithCustomError(dao, "BelowThreshold");
      await core.connect(whale).contribute(id, { value: ethers.parseEther("1") });
      await dao.connect(whale).propose(0, id, "ok");
    });
  });

  describe("quorum, timelock, anti-spam", () => {
    it("rejetée sans quorum : aucun vote POUR (même avec des votes contre)", async () => {
      const { dao, id, alice, bob } = await setup();
      await dao.connect(alice).propose(0, id, "x");
      await dao.connect(bob).castVote(0, false); // seulement un vote contre : 0 « pour » < 10 % de l'offre
      await time.increase(VOTING_PERIOD + 1);
      expect(await dao.state(0)).to.equal(2n); // Defeated
      await expect(dao.queue(0)).to.be.revertedWithCustomError(dao, "WrongState");
    });

    it("vote encore ouvert -> pas de queue ; vote fermé -> plus de vote", async () => {
      const { dao, id, alice, bob } = await setup();
      await dao.connect(alice).propose(0, id, "x");
      await expect(dao.queue(0)).to.be.revertedWithCustomError(dao, "WrongState");
      await time.increase(VOTING_PERIOD + 1);
      await expect(dao.connect(bob).castVote(0, true)).to.be.revertedWithCustomError(dao, "NotActive");
    });

    it("une seule proposition ouverte par (type, campagne), libérable après rejet", async () => {
      const { dao, id, alice } = await setup();
      await dao.connect(alice).propose(0, id, "x");
      await expect(dao.connect(alice).propose(0, id, "y")).to.be.revertedWithCustomError(dao, "AlreadyOpen");
      await time.increase(VOTING_PERIOD + 1);
      await dao.release(0);
      await dao.connect(alice).propose(0, id, "y");
    });

    it("expire si non exécutée dans la période de grâce", async () => {
      const { dao, id, alice, bob, carol } = await setup();
      await dao.connect(alice).propose(0, id, "x");
      for (const u of [alice, bob, carol]) await dao.connect(u).castVote(0, true);
      await time.increase(VOTING_PERIOD + 1);
      await dao.queue(0);
      await time.increase(TIMELOCK + 8 * DAY);
      expect(await dao.state(0)).to.equal(6n); // Expired
      await expect(dao.execute(0)).to.be.revertedWithCustomError(dao, "WrongState");
    });
  });

  describe("gel d'une campagne frauduleuse", () => {
    it("la DAO gèle la campagne et les contributeurs sont remboursés proportionnellement", async () => {
      const { core, token, dao, id, alice, bob, carol, dave, beneficiary } = await setup(); // 5 ETH levés / objectif 5
      // Tranche 1 validée et retirée (2.5 ETH)
      await dao.connect(alice).propose(0, id, "t1");
      for (const u of [alice, bob, carol]) await dao.connect(u).castVote(0, true);
      await time.increase(VOTING_PERIOD + 1);
      await dao.queue(0);
      await time.increase(TIMELOCK + 1);
      await dao.execute(0);
      await core.connect(beneficiary).withdrawFunds(id);

      // Fraude détectée -> gel
      await dao.connect(alice).propose(1, id, "Gel : activité suspecte");
      for (const u of [alice, bob, carol]) await dao.connect(u).castVote(1, true);
      await time.increase(VOTING_PERIOD + 1);
      await dao.queue(1);
      await time.increase(TIMELOCK + 1);
      await dao.execute(1);
      expect(await core.effectiveStatus(id)).to.equal(3n); // Canceled

      // Il reste 2.5 ETH (+ frais). Alice a mis 2/5 -> récupère 1 ETH.
      await expect(core.connect(alice).refund(id)).to.changeEtherBalance(alice, ethers.parseEther("1"));
      expect(await token.balanceOf(alice.address)).to.equal(0n);
      await expect(core.connect(beneficiary).withdrawFunds(id)).to.be.revertedWithCustomError(core, "InvalidStatus");
    });
  });
});

describe("CrowdfundDAO — gouvernance renforcée (anti-Sybil, quorum « pour », veto)", () => {
  describe("quorum sur les votes POUR (10 % de l'offre au snapshot)", () => {
    // Offre : alice/bob/carol/dave 20 ETH = 80 000 CFD ; attaquant 4 000 CFD ; testeur 3 000 CFD  => offre 87 000, quorum = 8 700 CFD « pour »
    async function bigSetup() {
      const ctx = await deployAll();
      const { core, creator, beneficiary, alice, bob, carol, dave, whale } = ctx;
      const id = await createCampaign(core, creator, beneficiary, { goal: "200" });
      for (const u of [alice, bob, carol, dave]) await core.connect(u).contribute(id, { value: ethers.parseEther("20") });
      await core.connect(whale).contribute(id, { value: ethers.parseEther("4") });
      return { ...ctx, id };
    }

    it("un attaquant minoritaire (4,6 % de l'offre) seul est rejeté faute de quorum", async () => {
      const { dao, id, whale } = await bigSetup();
      await dao.connect(whale).propose(0, id, "proposition malveillante");
      await dao.connect(whale).castVote(0, true); // 4000 « pour », aucun « contre »
      await time.increase(VOTING_PERIOD + 1);
      expect(await dao.state(0)).to.equal(2n); // Defeated : 4000 < 8700
    });

    it("les votes CONTRE ne comptent pas dans le quorum : pour > contre ne suffit pas", async () => {
      const { core, dao, id, whale, o1 } = await bigSetup();
      await core.connect(o1).contribute(id, { value: ethers.parseEther("3") }); // 3000 CFD (offre 90 000, quorum 9 000) — après le snapshot : on le fait AVANT la proposition
      await dao.connect(whale).propose(0, id, "x");
      await dao.connect(whale).castVote(0, true); // 4000 pour
      await dao.connect(o1).castVote(0, false); //   3000 contre
      await time.increase(VOTING_PERIOD + 1);
      expect(await dao.state(0)).to.equal(2n); // pour (4000) > contre (3000) mais 4000 < 9000
    });

    it("avec le soutien de vrais contributeurs, le quorum est atteint", async () => {
      const { dao, id, whale, alice } = await bigSetup();
      await dao.connect(whale).propose(0, id, "x");
      await dao.connect(whale).castVote(0, true); //  4000
      await dao.connect(alice).castVote(0, true); // 20000 -> 24000 >= 8700
      await time.increase(VOTING_PERIOD + 1);
      expect(await dao.state(0)).to.equal(3n); // Succeeded
    });

    it("paramètres invalides refusés à la construction", async () => {
      const { token, core, treasury } = await deployAll();
      const DAO = await ethers.getContractFactory("CrowdfundDAO");
      const [a, b, c] = [await token.getAddress(), await core.getAddress(), await treasury.getAddress()];
      await expect(DAO.deploy(a, b, VOTING_PERIOD, TIMELOCK, 1n, 0, 0n, 1, c)).to.be.revertedWith("bad params");
      await expect(DAO.deploy(a, b, VOTING_PERIOD, TIMELOCK, 1n, 10001, 0n, 1, c)).to.be.revertedWith("bad params");
      await expect(DAO.deploy(a, b, VOTING_PERIOD, TIMELOCK, 1n, 1000, 0n, 1, ethers.ZeroAddress)).to.be.revertedWith("zero address");
      await expect(DAO.deploy(a, b, VOTING_PERIOD, TIMELOCK, 1n, 1000, 0n, 0, c)).to.be.revertedWith("bad params"); // lookback >= 1
    });
  });

  describe("veto du multisig pendant le timelock", () => {
    async function queued() {
      const ctx = await setup();
      const { dao, id, alice, bob, carol } = ctx;
      await dao.connect(alice).propose(0, id, "x");
      for (const u of [alice, bob, carol]) await dao.connect(u).castVote(0, true);
      await time.increase(VOTING_PERIOD + 1);
      await dao.queue(0);
      return ctx;
    }
    const cancelData = (dao, n) => dao.interface.encodeFunctionData("cancel", [n, "fraude suspectée"]);

    it("le multisig (2 signatures sur 3) annule une proposition en file d'attente", async () => {
      const { core, dao, treasury, id, o1, o2 } = await queued();
      const daoAddr = await dao.getAddress();
      await treasury.connect(o1).submit(daoAddr, 0, cancelData(dao, 0)); // 1 confirmation (auto)
      await expect(treasury.connect(o1).execute(0)).to.be.revertedWithCustomError(treasury, "NotEnoughConfirmations");
      await treasury.connect(o2).confirm(0);
      await expect(treasury.connect(o1).execute(0)).to.emit(dao, "ProposalCanceled").withArgs(0n, await treasury.getAddress(), "fraude suspectée");
      expect(await dao.state(0)).to.equal(7n); // Canceled
      await time.increase(TIMELOCK + 1);
      await expect(dao.execute(0)).to.be.revertedWithCustomError(dao, "WrongState");
      expect(await core.effectiveStatus(id)).to.equal(0n); // la campagne n'a pas été touchée (Active)
    });

    it("seul le guardian (multisig) peut annuler", async () => {
      const { dao, alice } = await queued();
      await expect(dao.connect(alice).cancel(0, "x")).to.be.revertedWithCustomError(dao, "NotGuardian");
    });

    it("le veto n'est possible que sur une proposition EN FILE D'ATTENTE", async () => {
      const { dao, treasury, id, alice, o1, o2 } = await setup().then(async (c) => c);
      await dao.connect(alice).propose(0, id, "x"); // état Active
      await treasury.connect(o1).submit(await dao.getAddress(), 0, cancelData(dao, 0));
      await treasury.connect(o2).confirm(0);
      await expect(treasury.connect(o1).execute(0)).to.be.revertedWithCustomError(treasury, "CallFailed");
    });

    it("après un veto, une nouvelle proposition peut être ouverte pour la même campagne", async () => {
      const { dao, treasury, id, alice, o1, o2 } = await queued();
      await treasury.connect(o1).submit(await dao.getAddress(), 0, cancelData(dao, 0));
      await treasury.connect(o2).confirm(0);
      await treasury.connect(o1).execute(0);
      await dao.connect(alice).propose(0, id, "nouvelle proposition");
    });
  });
});

describe("CrowdfundDAO — réduction des limites (plancher de quorum, maturité du snapshot, droits d'admin)", () => {
  async function newDao(ctx, minQuorum, lookback) {
    const DAO = await ethers.getContractFactory("CrowdfundDAO");
    return DAO.deploy(await ctx.token.getAddress(), await ctx.core.getAddress(), VOTING_PERIOD, TIMELOCK, THRESHOLD, QUORUM_BPS,
      minQuorum, lookback, await ctx.treasury.getAddress());
  }

  it("plancher de quorum : au démarrage (offre minuscule), 10 % seuls ne suffisent plus", async () => {
    const ctx = await deployAll();
    const { core, dao, creator, beneficiary, alice, whale } = ctx;
    const id = await createCampaign(core, creator, beneficiary, { goal: "50" });
    await core.connect(alice).contribute(id, { value: ethers.parseEther("0.1") }); //  100 CFD
    await core.connect(whale).contribute(id, { value: ethers.parseEther("0.1") }); //  100 CFD : offre = 200, 10 % = 20 CFD
    // SANS plancher : l'attaquant (100 CFD « pour ») passe seul
    await dao.connect(whale).propose(0, id, "attaque au démarrage");
    await dao.connect(whale).castVote(0, true);
    await time.increase(VOTING_PERIOD + 1);
    expect(await dao.state(0)).to.equal(3n); // Succeeded : la faille
    // AVEC plancher de 1000 CFD : rejeté
    const safe = await newDao(ctx, ethers.parseEther("1000"), 1);
    await safe.connect(whale).propose(0, id, "attaque au démarrage");
    await safe.connect(whale).castVote(0, true);
    await time.increase(VOTING_PERIOD + 1);
    expect(await safe.state(0)).to.equal(2n); // Defeated
  });

  it("maturité du snapshot : contribuer puis proposer aussitôt ne donne aucun pouvoir", async () => {
    const ctx = await deployAll();
    const { core, creator, beneficiary, alice } = ctx;
    const dao = await newDao(ctx, 0n, 10); // snapshot = 10 blocs avant la proposition
    const id = await createCampaign(core, creator, beneficiary, { goal: "50" });
    await core.connect(alice).contribute(id, { value: ethers.parseEther("1") });
    await expect(dao.connect(alice).propose(0, id, "x")).to.be.revertedWithCustomError(dao, "BelowThreshold");
    await mine(10);
    await dao.connect(alice).propose(0, id, "x"); // les jetons ont maintenant « mûri »
    await dao.connect(alice).castVote(0, true);
  });

  it("droits d'administration : transférés au multisig, le déployeur ne peut plus s'accorder de rôle", async () => {
    const { admin, token, core, treasury, alice, o1, o2 } = await deployAll();
    const ADMIN = await token.DEFAULT_ADMIN_ROLE();
    const ms = await treasury.getAddress();
    for (const c of [token, core]) { await c.grantRole(ADMIN, ms); await c.renounceRole(ADMIN, admin.address); }
    expect(await token.hasRole(ADMIN, admin.address)).to.equal(false);
    expect(await core.hasRole(ADMIN, admin.address)).to.equal(false);
    expect(await token.hasRole(ADMIN, ms)).to.equal(true);
    // le déployeur ne peut plus s'attribuer MINTER / GOVERNANCE
    await expect(token.connect(admin).grantRole(await token.MINTER_ROLE(), alice.address)).to.be.reverted;
    await expect(core.connect(admin).grantRole(await core.GOVERNANCE_ROLE(), alice.address)).to.be.reverted;
    // le multisig peut le faire, mais seulement avec 2 signatures
    const data = token.interface.encodeFunctionData("grantRole", [await token.MINTER_ROLE(), alice.address]);
    await treasury.connect(o1).submit(await token.getAddress(), 0, data);
    await expect(treasury.connect(o1).execute(0)).to.be.revertedWithCustomError(treasury, "NotEnoughConfirmations");
    await treasury.connect(o2).confirm(0);
    await treasury.connect(o1).execute(0);
    expect(await token.hasRole(await token.MINTER_ROLE(), alice.address)).to.equal(true);
  });
});

describe("Exécution automatique (keeper : checkUpkeep / performUpkeep)", () => {
  it("un robot sans privilège fait avancer la proposition adoptée : mise en file puis exécution", async () => {
    const { core, dao, id, alice, bob, carol, dave } = await setup();
    await dao.connect(alice).propose(0, id, "t1");
    for (const u of [alice, bob, carol]) await dao.connect(u).castVote(0, true);

    // vote encore ouvert : rien à faire
    let [need] = await dao.checkUpkeep("0x");
    expect(need).to.equal(false);

    await time.increase(VOTING_PERIOD + 1);
    let [need1, data1] = await dao.checkUpkeep("0x");
    expect(need1).to.equal(true);
    await dao.connect(dave).performUpkeep(data1); // « dave » joue le robot : aucun rôle spécial
    expect(await dao.state(0)).to.equal(4n); // Queued

    // timelock pas écoulé : plus rien à faire, et forcer l'action échoue
    let [need2] = await dao.checkUpkeep("0x");
    expect(need2).to.equal(false);
    const forced = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint8"], [0, 1]);
    await expect(dao.connect(dave).performUpkeep(forced)).to.be.revertedWithCustomError(dao, "TimelockNotElapsed");

    await time.increase(TIMELOCK + 1);
    let [need3, data3] = await dao.checkUpkeep("0x");
    expect(need3).to.equal(true);
    await dao.connect(dave).performUpkeep(data3);
    expect(await dao.state(0)).to.equal(5n); // Executed
    expect((await core.getCampaign(id)).tranchesApproved).to.equal(1n);

    // plus rien à faire
    expect((await dao.checkUpkeep("0x"))[0]).to.equal(false);
  });

  it("le robot ne peut rien imposer : action inconnue ou proposition non adoptée", async () => {
    const { dao, id, alice } = await setup();
    await dao.connect(alice).propose(0, id, "t1");
    const bad = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint8"], [0, 7]);
    await expect(dao.performUpkeep(bad)).to.be.revertedWithCustomError(dao, "InvalidAction");
    const early = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint8"], [0, 0]);
    await expect(dao.performUpkeep(early)).to.be.revertedWithCustomError(dao, "WrongState"); // vote en cours
  });
});