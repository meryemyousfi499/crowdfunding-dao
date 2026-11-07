require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const { SEPOLIA_RPC_URL, PRIVATE_KEY } = process.env;

// Repli hors-ligne : si le téléchargement du compilateur natif est impossible
// (réseau restreint), on utilise solc-js installé via npm (USE_SOLCJS=1).
if (process.env.USE_SOLCJS === "1") {
  const { subtask } = require("hardhat/config");
  const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");
  subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
    if (args.solcVersion === "0.8.24") {
      const compilerPath = require.resolve("solc/soljson.js");
      return { compilerPath, isSolcJs: true, version: "0.8.24", longVersion: "0.8.24+commit.e11b9ed9.Emscripten.clang" };
    }
    return runSuper();
  });
}

module.exports = {
  etherscan: { apiKey: process.env.ETHERSCAN_API_KEY || "" },
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  networks: {
    hardhat: { chainId: 31337 },
    localhost: { url: "http://127.0.0.1:8545", chainId: 31337 },
    ...(SEPOLIA_RPC_URL && PRIVATE_KEY
      ? { sepolia: { url: SEPOLIA_RPC_URL, accounts: [PRIVATE_KEY], chainId: 11155111 } }
      : {}),
  },
};
