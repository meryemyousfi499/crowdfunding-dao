const { expect } = require("chai");
const { ethers } = require("hardhat");
const { mine } = require("@nomicfoundation/hardhat-network-helpers");
const { deployAll, createCampaign, time, DAY, VOTING_PERIOD, TIMELOCK } = require("./helpers");

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

  describe("vote quadratique", () => {
    it("poids = racine carrée du solde : une baleine n'écrase pas les petits porteurs", async () => {
      const { core, dao, id, creator, beneficiary, alice, bob, carol, dave, whale } = await deployAll().then(async (c) => ({
        ...c,
        id: await createCampaign(c.core, c.creator, c.beneficiary, { goal: "100" }),
      }));
      await core.connect(whale).contribute(id, { value: ethers.parseEther("16") }); // 16000 CFD -> poids 126
      for (const u of [alice, bob, carol, dave]) await core.connect(u).contribute(id, { value: ethers.parseEther("4") }); // 4000 -> 63
      await dao.connect(alice).propose(0, id, "x");
      await dao.connect(whale).castVote(0, false);
      for (const u of [alice, bob, carol]) await dao.connect(u).castVote(0, true);
      const p = await dao.getProposal(0);
      expect(p.againstVotes).to.equal(126n); // sqrt(16000)=126
      expect(p.forVotes).to.equal(63n * 3n); // 3 x sqrt(4000)=63
      // En vote linéaire : 16000 > 12000 (la baleine gagnerait). En quadratique : 189 > 126.
      expect(p.forVotes).to.be.greaterThan(p.againstVotes);
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
    it("rejetée sans quorum (< 3 votants)", async () => {
      const { dao, id, alice, bob } = await setup();
      await dao.connect(alice).propose(0, id, "x");
      await dao.connect(alice).castVote(0, true);
      await dao.connect(bob).castVote(0, true);
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
